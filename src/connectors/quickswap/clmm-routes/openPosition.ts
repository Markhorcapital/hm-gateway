import { FastifyPluginAsync } from 'fastify';
import { BigNumber, Contract } from 'ethers';

import {
    OpenPositionRequestType,
    OpenPositionRequest,
    OpenPositionResponseType,
    OpenPositionResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import { Ethereum } from '../../../chains/ethereum/ethereum';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';

const openPositionRoute: FastifyPluginAsync = async (fastify) => {
    await fastify.register(require('@fastify/sensible'));

    // Get first wallet address for example
    const ethereum = await Ethereum.getInstance('polygon');
    let firstWalletAddress = '<ethereum-wallet-address>';

    try {
        firstWalletAddress =
            (await ethereum.getFirstWalletAddress()) || firstWalletAddress;
    } catch (error) {
        logger.warn('No wallets found for examples in schema');
    }

    fastify.post<{
        Body: OpenPositionRequestType;
        Reply: OpenPositionResponseType;
    }>(
        '/open-position',
        {
            schema: {
                tags: ['quickswap/clmm'],
                body: {
                    ...OpenPositionRequest,
                    properties: {
                        ...OpenPositionRequest.properties,
                        network: { type: 'string', default: 'polygon' },
                        walletAddress: { type: 'string', examples: [firstWalletAddress] },
                        lowerPrice: { type: 'number', examples: [0.001] },
                        upperPrice: { type: 'number', examples: [0.002] },
                        poolAddress: { type: 'string', examples: [''] },
                        baseToken: { type: 'string', examples: ['ALI'] },
                        quoteToken: { type: 'string', examples: ['WPOL'] },
                        baseTokenAmount: { type: 'number', examples: [100] },
                        quoteTokenAmount: { type: 'number', examples: [0.1] },
                        slippagePct: { type: 'number', examples: [1] },
                    },
                },
                response: {
                    200: OpenPositionResponse,
                },
            },
        },
        async (request) => {
            try {
                const {
                    network,
                    walletAddress,
                    lowerPrice,
                    upperPrice,
                    poolAddress,
                    baseToken,
                    quoteToken,
                    baseTokenAmount,
                    quoteTokenAmount,
                    slippagePct,
                } = request.body;

                const networkToUse = network || 'polygon';

                // Validate essential parameters
                if (!walletAddress || !lowerPrice || !upperPrice) {
                    throw fastify.httpErrors.badRequest('Missing required parameters: walletAddress, lowerPrice, upperPrice');
                }

                if (!poolAddress && (!baseToken || !quoteToken)) {
                    throw fastify.httpErrors.badRequest('Either poolAddress or both baseToken and quoteToken must be provided');
                }

                if (!baseTokenAmount && !quoteTokenAmount) {
                    throw fastify.httpErrors.badRequest('Either baseTokenAmount or quoteTokenAmount must be provided');
                }

                // Get instances
                const quickswap = await QuickSwap.getInstance(networkToUse);
                const ethereum = await Ethereum.getInstance(networkToUse);

                if (!quickswap.supportsV3) {
                    throw fastify.httpErrors.badRequest('QuickSwap V3 not supported on this network');
                }

                // Get wallet
                const wallet = await ethereum.getWallet(walletAddress);
                if (!wallet) {
                    throw fastify.httpErrors.badRequest('Wallet not found');
                }

                // Find pool address if not provided
                let poolAddressToUse = poolAddress;
                if (!poolAddressToUse) {
                    poolAddressToUse = await quickswap.findDefaultPool(
                        baseToken,
                        quoteToken,
                        'clmm',
                    );

                    if (!poolAddressToUse) {
                        throw fastify.httpErrors.notFound(
                            `No CLMM pool found for pair ${baseToken}-${quoteToken}`,
                        );
                    }
                }

                // Get token objects
                const baseTokenObj = baseToken ? quickswap.getTokenBySymbol(baseToken) : null;
                const quoteTokenObj = quoteToken ? quickswap.getTokenBySymbol(quoteToken) : null;

                if (!baseTokenObj || !quoteTokenObj) {
                    throw fastify.httpErrors.badRequest('Tokens not found');
                }

                // Convert prices to ticks
                const lowerTick = priceToTick(lowerPrice, baseTokenObj.decimals, quoteTokenObj.decimals);
                const upperTick = priceToTick(upperPrice, baseTokenObj.decimals, quoteTokenObj.decimals);

                // Calculate amounts in Wei
                const baseTokenAmountWei = baseTokenAmount
                    ? BigNumber.from(baseTokenAmount.toString()).mul(BigNumber.from(10).pow(baseTokenObj.decimals))
                    : BigNumber.from(0);
                const quoteTokenAmountWei = quoteTokenAmount
                    ? BigNumber.from(quoteTokenAmount.toString()).mul(BigNumber.from(10).pow(quoteTokenObj.decimals))
                    : BigNumber.from(0);

                // Get NFT manager contract
                const nftManager = quickswap.nftManagerV3;
                if (!nftManager) {
                    throw fastify.httpErrors.internalServerError('NFT manager not available');
                }

                // Prepare mint parameters
                const mintParams = {
                    token0: baseTokenObj.address < quoteTokenObj.address ? baseTokenObj.address : quoteTokenObj.address,
                    token1: baseTokenObj.address < quoteTokenObj.address ? quoteTokenObj.address : baseTokenObj.address,
                    fee: 3000, // Default to 0.3% fee tier
                    tickLower: lowerTick,
                    tickUpper: upperTick,
                    amount0Desired: baseTokenAmountWei,
                    amount1Desired: quoteTokenAmountWei,
                    amount0Min: 0, // Will be calculated based on slippage
                    amount1Min: 0, // Will be calculated based on slippage
                    recipient: walletAddress,
                    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
                };

                // Apply slippage if provided
                if (slippagePct) {
                    const slippageMultiplier = 1 - (slippagePct / 100);
                    mintParams.amount0Min = baseTokenAmountWei.mul(Math.floor(slippageMultiplier * 1000)).div(1000).toNumber();
                    mintParams.amount1Min = quoteTokenAmountWei.mul(Math.floor(slippageMultiplier * 1000)).div(1000).toNumber();
                }

                // Execute mint transaction
                const mintTx = await nftManager.connect(wallet).mint(mintParams);
                const receipt = await mintTx.wait();

                // Extract position data from transaction logs
                let positionAddress = '';
                let actualBaseTokenAmount = 0;
                let actualQuoteTokenAmount = 0;

                // Parse logs to get actual amounts and position address
                for (const log of receipt.logs) {
                    try {
                        // Look for Transfer event to NFT manager (position creation)
                        if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                            // This is a Transfer event, check if it's to the NFT manager
                            const decoded = nftManager.interface.parseLog(log);
                            if (decoded && decoded.name === 'Transfer') {
                                const [from, to, tokenId] = decoded.args;
                                if (to === walletAddress && from === '0x0000000000000000000000000000000000000000') {
                                    // This is a new position mint
                                    positionAddress = tokenId.toString();
                                }
                            }
                        }
                    } catch (error) {
                        // Ignore parsing errors for logs
                        continue;
                    }
                }

                // Calculate gas fee
                const gasUsed = receipt.gasUsed;
                const gasPrice = receipt.effectiveGasPrice || mintTx.gasPrice;
                const gasFee = parseFloat(gasUsed.mul(gasPrice).toString()) / 1e18; // Convert to ETH

                // Calculate actual amounts (simplified - in reality would parse from logs)
                actualBaseTokenAmount = formatTokenAmount(baseTokenAmountWei.toString(), baseTokenObj.decimals);
                actualQuoteTokenAmount = formatTokenAmount(quoteTokenAmountWei.toString(), quoteTokenObj.decimals);

                logger.info('QuickSwap CLMM position opened successfully', {
                    network: networkToUse,
                    walletAddress,
                    positionAddress,
                    baseToken: baseTokenObj.symbol,
                    quoteToken: quoteTokenObj.symbol,
                    lowerPrice,
                    upperPrice,
                    lowerTick,
                    upperTick,
                    baseTokenAmount: actualBaseTokenAmount,
                    quoteTokenAmount: actualQuoteTokenAmount,
                    txHash: receipt.transactionHash,
                    gasFee,
                });

                return {
                    signature: receipt.transactionHash,
                    fee: gasFee,
                    positionAddress: positionAddress || 'unknown',
                    positionRent: 0, // Algebra V3 doesn't have position rent like Meteora
                    baseTokenAmountAdded: actualBaseTokenAmount,
                    quoteTokenAmountAdded: actualQuoteTokenAmount,
                };
            } catch (error) {
                logger.error('QuickSwap CLMM open position failed', error);
                if (error.statusCode) {
                    throw error; // Already a formatted Fastify error
                } else {
                    throw fastify.httpErrors.internalServerError(
                        `Open position failed: ${error.message}`,
                    );
                }
            }
        },
    );
};

/**
 * Convert price to tick for Algebra V3
 */
function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
    // Formula: tick = log(price) / log(1.0001)
    // This is a simplified calculation
    const tickMultiplier = 1.0001;
    const adjustedPrice = price / Math.pow(10, token1Decimals - token0Decimals);
    const tick = Math.log(adjustedPrice) / Math.log(tickMultiplier);
    return Math.floor(tick);
}

export default openPositionRoute; 