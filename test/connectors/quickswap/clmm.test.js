const fs = require('fs');
const path = require('path');

const { test, describe, expect, beforeEach } = require('@jest/globals');
const axios = require('axios');

// Constants for this test file
const CONNECTOR = 'quickswap';
const PROTOCOL = 'clmm';
const NETWORK = 'polygon';
const BASE_TOKEN = 'WPOL';
const QUOTE_TOKEN = 'USDC';
const ALI_TOKEN = 'ALI';
const TEST_POOL = '0x24Bf2Ee2e09477082d1DDf2F0603baa460B3F5f3'; // ALI-WPOL V3
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

describe('QuickSwap CLMM Tests (Polygon Network)', () => {
    beforeEach(() => {
        // Reset axios mocks before each test
        axios.get.mockClear();
        axios.post.mockClear();
    });

    describe('CLMM Pool Info Endpoint', () => {
        test('returns and validates pool info for ALI-WPOL', async () => {
            // Load mock response
            const mockResponse = loadMockResponse('clmm-pool-info');

            // Setup mock axios
            axios.get.mockResolvedValueOnce({
                status: 200,
                data: mockResponse,
            });

            // Make the request
            const response = await axios.get(
                `http://localhost:15888/connectors/${CONNECTOR}/${PROTOCOL}/pool-info`,
                {
                    params: {
                        network: NETWORK,
                        baseToken: ALI_TOKEN,
                        quoteToken: BASE_TOKEN,
                    },
                },
            );

            // Validate the response
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('address');
            expect(response.data).toHaveProperty('baseTokenAddress');
            expect(response.data).toHaveProperty('quoteTokenAddress');
            expect(response.data).toHaveProperty('feePct');
            expect(response.data).toHaveProperty('price');

            // Check expected mock values
            expect(response.data.address).toBe(TEST_POOL);
            expect(response.data.baseTokenAddress).toBe('0xbFc70507384047Aa74c29Cdc8c5Cb88D0f7213AC'); // ALI
            expect(response.data.quoteTokenAddress).toBe('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'); // WPOL
        });

        test('handles error for non-existent pool', async () => {
            // Setup mock axios with error response
            axios.get.mockRejectedValueOnce({
                response: {
                    status: 404,
                    data: { error: 'Pool not found' },
                },
            });

            // Make the request and expect it to be rejected
            await expect(
                axios.get(
                    `http://localhost:15888/connectors/${CONNECTOR}/${PROTOCOL}/pool-info`,
                    {
                        params: {
                            network: NETWORK,
                            baseToken: 'NONEXISTENT',
                            quoteToken: BASE_TOKEN,
                        },
                    },
                ),
            ).rejects.toMatchObject({
                response: {
                    status: 404,
                    data: { error: 'Pool not found' },
                },
            });
        });
    });

    describe('CLMM Quote Swap Endpoint', () => {
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
                `http://localhost:15888/connectors/${CONNECTOR}/${PROTOCOL}/quote-swap`,
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
            expect(response.data).toHaveProperty('base');
            expect(response.data).toHaveProperty('quote');
            expect(response.data).toHaveProperty('amount');
            expect(response.data).toHaveProperty('side');
            expect(response.data).toHaveProperty('network');
            expect(response.data).toHaveProperty('expectedAmount');
            expect(response.data).toHaveProperty('price');
            expect(response.data).toHaveProperty('poolAddress');

            // Check expected values
            expect(response.data.base).toBe(ALI_TOKEN);
            expect(response.data.quote).toBe(BASE_TOKEN);
            expect(response.data.amount).toBe('1000');
            expect(response.data.side).toBe('SELL');
            expect(response.data.network).toBe(NETWORK);
            expect(response.data.poolAddress).toBe(TEST_POOL);
        });
    });
}); 