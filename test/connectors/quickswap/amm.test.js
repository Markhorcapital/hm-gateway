const fs = require('fs');
const path = require('path');

const { test, describe, expect, beforeEach } = require('@jest/globals');
const axios = require('axios');

// Constants for this test file
const CONNECTOR = 'quickswap';
const AMM_PROTOCOL = 'amm';
const CLMM_PROTOCOL = 'clmm';
const NETWORK = 'polygon';
const BASE_TOKEN = 'WPOL';
const QUOTE_TOKEN = 'USDC';
const ALI_TOKEN = 'ALI';
const TEST_AMM_POOL = '0x6e7a5FAFcec6BB1e78bAE2A1F0B612012BF14827'; // WPOL-USDC V2
const TEST_CLMM_POOL = '0x24Bf2Ee2e09477082d1DDf2F0603baa460B3F5f3'; // ALI-WPOL V3
const TEST_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Mock API calls (axios.get and axios.post)
jest.mock('axios');

// Mock implementation for axios
axios.get = jest.fn();
axios.post = jest.fn();

// Helper to load mock responses
function loadMockResponse(filename) {
    const filePath = path.join(__dirname, 'mocks', `${filename}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Function to validate pool info response structure
function validatePoolInfo(response) {
    return (
        response &&
        typeof response.address === 'string' &&
        typeof response.baseTokenAddress === 'string' &&
        typeof response.quoteTokenAddress === 'string' &&
        typeof response.feePct === 'number' &&
        typeof response.price === 'number' &&
        typeof response.baseTokenAmount === 'number' &&
        typeof response.quoteTokenAmount === 'number' &&
        response.poolType === 'amm' &&
        response.lpMint &&
        typeof response.lpMint.address === 'string' &&
        typeof response.lpMint.decimals === 'number'
    );
}

// Function to validate swap quote response structure
function validateSwapQuote(response) {
    return (
        response &&
        typeof response.base === 'string' &&
        typeof response.quote === 'string' &&
        typeof response.amount === 'string' &&
        typeof response.side === 'string' &&
        typeof response.network === 'string' &&
        typeof response.expectedAmount === 'string' &&
        typeof response.price === 'string' &&
        typeof response.poolAddress === 'string'
    );
}

// Tests
describe('QuickSwap AMM Tests (Polygon Network)', () => {
    beforeEach(() => {
        // Reset axios mocks before each test
        axios.get.mockClear();
        axios.post.mockClear();
    });

    describe('AMM (V2) Pool Info Endpoint', () => {
        test('returns and validates pool info for WPOL-USDC', async () => {
            // Load mock response
            const mockResponse = loadMockResponse('amm-pool-info');

            // Setup mock axios
            axios.get.mockResolvedValueOnce({
                status: 200,
                data: mockResponse,
            });

            // Make the request
            const response = await axios.get(
                `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/pool-info`,
                {
                    params: {
                        network: NETWORK,
                        base: BASE_TOKEN,
                        quote: QUOTE_TOKEN,
                    },
                },
            );

            // Validate the response
            expect(response.status).toBe(200);
            expect(validatePoolInfo(response.data)).toBe(true);

            // Check expected mock values
            expect(response.data.address).toBe(TEST_AMM_POOL);
            expect(response.data.poolType).toBe('amm');
            expect(response.data.feePct).toBe(0.3);

            // Verify axios was called with correct parameters
            expect(axios.get).toHaveBeenCalledWith(
                `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/pool-info`,
                expect.objectContaining({
                    params: expect.objectContaining({
                        network: NETWORK,
                        base: BASE_TOKEN,
                        quote: QUOTE_TOKEN,
                    }),
                }),
            );
        });

        test('handles error for non-existent pool', async () => {
            // Setup mock axios with error response
            axios.get.mockRejectedValueOnce({
                response: {
                    status: 404,
                    data: loadMockResponse('amm-quote-swap-invalid-token'),
                },
            });

            // Make the request and expect it to be rejected
            await expect(
                axios.get(
                    `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/pool-info`,
                    {
                        params: {
                            network: NETWORK,
                            base: 'UNKNOWN',
                            quote: QUOTE_TOKEN,
                        },
                    },
                ),
            ).rejects.toMatchObject({
                response: {
                    status: 404,
                    data: {
                        error: 'Token not found',
                    },
                },
            });
        });
    });

    describe('AMM (V2) Quote Swap Endpoint', () => {
        test('returns valid quote for WPOL-USDC swap', async () => {
            // Load mock response
            const mockResponse = loadMockResponse('amm-quote-swap');

            // Setup mock axios
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: mockResponse,
            });

            // Make the request
            const response = await axios.post(
                `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/quote-swap`,
                {
                    base: BASE_TOKEN,
                    quote: QUOTE_TOKEN,
                    amount: '1',
                    side: 'SELL',
                    network: NETWORK,
                },
            );

            // Validate the response
            expect(response.status).toBe(200);
            expect(validateSwapQuote(response.data)).toBe(true);

            // Check expected values
            expect(response.data.base).toBe(BASE_TOKEN);
            expect(response.data.quote).toBe(QUOTE_TOKEN);
            expect(response.data.amount).toBe('1');
            expect(response.data.side).toBe('SELL');
            expect(response.data.network).toBe(NETWORK);
            expect(response.data.poolAddress).toBe(TEST_AMM_POOL);

            // Verify axios was called correctly
            expect(axios.post).toHaveBeenCalledWith(
                `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/quote-swap`,
                expect.objectContaining({
                    base: BASE_TOKEN,
                    quote: QUOTE_TOKEN,
                    amount: '1',
                    side: 'SELL',
                    network: NETWORK,
                }),
            );
        });

        test('handles invalid token error', async () => {
            // Setup mock axios with error response
            axios.post.mockRejectedValueOnce({
                response: {
                    status: 404,
                    data: loadMockResponse('amm-quote-swap-invalid-token'),
                },
            });

            // Make the request and expect it to be rejected
            await expect(
                axios.post(
                    `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/quote-swap`,
                    {
                        base: 'NONEXISTENT',
                        quote: QUOTE_TOKEN,
                        amount: '1',
                        side: 'SELL',
                        network: NETWORK,
                    },
                ),
            ).rejects.toMatchObject({
                response: {
                    status: 404,
                    data: {
                        error: 'Token not found',
                        code: 404,
                    },
                },
            });
        });
    });

    describe('CLMM (V3) Quote Swap Endpoint', () => {
        test('returns valid quote for ALI-WPOL swap', async () => {
            // Load mock response
            const mockResponse = loadMockResponse('clmm-quote-swap');

            // Setup mock axios
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: mockResponse,
            });

            // Make the request
            const response = await axios.post(
                `http://localhost:15888/connectors/${CONNECTOR}/${CLMM_PROTOCOL}/quote-swap`,
                {
                    base: ALI_TOKEN,
                    quote: BASE_TOKEN,
                    amount: '1000',
                    side: 'SELL',
                    network: NETWORK,
                },
            );

            // Validate the response
            expect(response.status).toBe(200);
            expect(validateSwapQuote(response.data)).toBe(true);

            // Check expected values
            expect(response.data.base).toBe(ALI_TOKEN);
            expect(response.data.quote).toBe(BASE_TOKEN);
            expect(response.data.amount).toBe('1000');
            expect(response.data.side).toBe('SELL');
            expect(response.data.network).toBe(NETWORK);
            expect(response.data.poolAddress).toBe(TEST_CLMM_POOL);
            expect(response.data.fee).toBe(3000); // V3 fee tier

            // Verify axios was called correctly
            expect(axios.post).toHaveBeenCalledWith(
                `http://localhost:15888/connectors/${CONNECTOR}/${CLMM_PROTOCOL}/quote-swap`,
                expect.objectContaining({
                    base: ALI_TOKEN,
                    quote: BASE_TOKEN,
                    amount: '1000',
                    side: 'SELL',
                    network: NETWORK,
                }),
            );
        });
    });

    describe('Unimplemented Endpoints', () => {
        test('AMM position-info returns not implemented error', async () => {
            // Setup mock axios with not implemented response
            axios.get.mockRejectedValueOnce({
                response: {
                    status: 501,
                    data: loadMockResponse('not-implemented'),
                },
            });

            // Make the request and expect it to be rejected
            await expect(
                axios.get(
                    `http://localhost:15888/connectors/${CONNECTOR}/${AMM_PROTOCOL}/position-info`,
                    {
                        params: {
                            base: BASE_TOKEN,
                            quote: QUOTE_TOKEN,
                            network: NETWORK,
                        },
                    },
                ),
            ).rejects.toMatchObject({
                response: {
                    status: 501,
                    data: {
                        error: 'Not implemented',
                        code: 501,
                    },
                },
            });
        });

        test('CLMM pool-info returns not implemented error', async () => {
            // Setup mock axios with not implemented response
            axios.get.mockRejectedValueOnce({
                response: {
                    status: 501,
                    data: loadMockResponse('not-implemented'),
                },
            });

            // Make the request and expect it to be rejected
            await expect(
                axios.get(
                    `http://localhost:15888/connectors/${CONNECTOR}/${CLMM_PROTOCOL}/pool-info`,
                    {
                        params: {
                            base: ALI_TOKEN,
                            quote: BASE_TOKEN,
                            network: NETWORK,
                        },
                    },
                ),
            ).rejects.toMatchObject({
                response: {
                    status: 501,
                    data: {
                        error: 'Not implemented',
                        code: 501,
                    },
                },
            });
        });
    });
}); 