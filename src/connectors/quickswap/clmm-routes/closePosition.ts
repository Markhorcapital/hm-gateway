import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  ClosePositionRequestType,
  ClosePositionRequest,
  ClosePositionResponseType,
  ClosePositionResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';

const closePositionRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  // Get first wallet address for example
  const ethereum = await Ethereum.getInstance('polygon');
  let firstWalletAddress = '<ethereum-wallet-address>';

  try {
    firstWalletAddress = (await Ethereum.getFirstWalletAddress()) || firstWalletAddress;
  } catch (error) {
    logger.warn('No wallets found for examples in schema');
  }

  fastify.post<{
    Body: ClosePositionRequestType;
    Reply: ClosePositionResponseType;
  }>(
    '/close-position',
    {
      schema: {
        tags: ['quickswap/clmm'],
        body: {
          ...ClosePositionRequest,
          properties: {
            ...ClosePositionRequest.properties,
            network: { type: 'string', default: 'polygon' },
            walletAddress: { type: 'string', examples: [firstWalletAddress] },
            positionAddress: { type: 'string', examples: ['123'] },
          },
        },
        response: {
          200: ClosePositionResponse,
        },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress } = request.body;

        const networkToUse = network || 'polygon';

        // Validate essential parameters
        if (!walletAddress || !positionAddress) {
          throw fastify.httpErrors.badRequest('Missing required parameters: walletAddress, positionAddress');
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

        // Get NFT manager contract
        const nftManager = quickswap.nftManagerV3;
        if (!nftManager) {
          throw fastify.httpErrors.internalServerError('NFT manager not available');
        }

        // Get position data first to validate it exists and belongs to the wallet
        const position = await nftManager.positions(positionAddress);
        if (!position || position.liquidity.toString() === '0') {
          throw fastify.httpErrors.notFound('Position not found or has no liquidity');
        }

        // Check if position belongs to the wallet
        const positionOwner = await nftManager.ownerOf(positionAddress);
        if (positionOwner.toLowerCase() !== walletAddress.toLowerCase()) {
          throw fastify.httpErrors.forbidden('Position does not belong to the specified wallet');
        }

        // Get token objects
        const token0Obj = quickswap.getTokenByAddress(position.token0);
        const token1Obj = quickswap.getTokenByAddress(position.token1);

        if (!token0Obj || !token1Obj) {
          throw fastify.httpErrors.badRequest('Position tokens not found');
        }

        // Prepare collect and burn parameters
        const collectParams = {
          tokenId: positionAddress,
          recipient: walletAddress,
          amount0Max: BigNumber.from(2).pow(128).sub(1), // Max uint128
          amount1Max: BigNumber.from(2).pow(128).sub(1), // Max uint128
        };

        const burnParams = {
          tokenId: positionAddress,
        };

        // Execute collect transaction to collect fees first
        const collectTx = await nftManager.connect(wallet).collect(collectParams);
        const collectReceipt = await collectTx.wait();

        // Execute burn transaction to close position
        const burnTx = await nftManager.connect(wallet).burn(burnParams);
        const burnReceipt = await burnTx.wait();

        // Calculate gas fees
        const collectGasUsed = collectReceipt.gasUsed;
        const collectGasPrice = collectReceipt.effectiveGasPrice || collectTx.gasPrice;
        const collectGasFee = parseFloat(collectGasUsed.mul(collectGasPrice).toString()) / 1e18;

        const burnGasUsed = burnReceipt.gasUsed;
        const burnGasPrice = burnReceipt.effectiveGasPrice || burnTx.gasPrice;
        const burnGasFee = parseFloat(burnGasUsed.mul(burnGasPrice).toString()) / 1e18;

        const totalGasFee = collectGasFee + burnGasFee;

        // Parse logs to get actual amounts collected and removed
        let baseTokenAmountRemoved = 0;
        let quoteTokenAmountRemoved = 0;
        let baseFeeAmountCollected = 0;
        let quoteFeeAmountCollected = 0;

        // Parse collect transaction logs
        for (const log of collectReceipt.logs) {
          try {
            // Look for Transfer events from the position
            if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
              const decoded = nftManager.interface.parseLog(log);
              if (decoded && decoded.name === 'Transfer') {
                const [from, to, amount] = decoded.args;
                if (to === walletAddress) {
                  // This is a fee collection
                  if (from === position.token0) {
                    baseFeeAmountCollected = formatTokenAmount(amount.toString(), token0Obj.decimals);
                  } else if (from === position.token1) {
                    quoteFeeAmountCollected = formatTokenAmount(amount.toString(), token1Obj.decimals);
                  }
                }
              }
            }
          } catch (error) {
            // Ignore parsing errors for logs
            continue;
          }
        }

        // Parse burn transaction logs
        for (const log of burnReceipt.logs) {
          try {
            // Look for Transfer events from the position
            if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
              const decoded = nftManager.interface.parseLog(log);
              if (decoded && decoded.name === 'Transfer') {
                const [from, to, amount] = decoded.args;
                if (to === walletAddress) {
                  // This is a liquidity removal
                  if (from === position.token0) {
                    baseTokenAmountRemoved = formatTokenAmount(amount.toString(), token0Obj.decimals);
                  } else if (from === position.token1) {
                    quoteTokenAmountRemoved = formatTokenAmount(amount.toString(), token1Obj.decimals);
                  }
                }
              }
            }
          } catch (error) {
            // Ignore parsing errors for logs
            continue;
          }
        }

        logger.info('QuickSwap CLMM position closed successfully', {
          network: networkToUse,
          walletAddress,
          positionAddress,
          baseToken: token0Obj.symbol,
          quoteToken: token1Obj.symbol,
          baseTokenAmountRemoved,
          quoteTokenAmountRemoved,
          baseFeeAmountCollected,
          quoteFeeAmountCollected,
          collectTxHash: collectReceipt.transactionHash,
          burnTxHash: burnReceipt.transactionHash,
          totalGasFee,
        });

        return {
          signature: `${collectReceipt.transactionHash},${burnReceipt.transactionHash}`,
          status: 1, // CONFIRMED
          data: {
            fee: totalGasFee,
            positionRentRefunded: 0, // Algebra V3 doesn't have position rent like Meteora
            baseTokenAmountRemoved,
            quoteTokenAmountRemoved,
            baseFeeAmountCollected,
            quoteFeeAmountCollected,
          },
        };
      } catch (error) {
        logger.error('QuickSwap CLMM close position failed', error);
        if (error.statusCode) {
          throw error; // Already a formatted Fastify error
        } else {
          throw fastify.httpErrors.internalServerError(`Close position failed: ${error.message}`);
        }
      }
    },
  );
};

export default closePositionRoute;
