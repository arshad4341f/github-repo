const Web3 = require('web3');
const { ChainId, Fetcher, Route, Trade, TokenAmount, TradeType, Percent } = require('@uniswap/sdk');
const axios = require('axios');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const dotenv = require('dotenv');

// Load environment variables from a .env file
dotenv.config();

// Setup Web3 and connect to the blockchain
const web3 = new Web3(process.env.INFURA_OR_NODE_URL);
const myAccount = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
web3.eth.accounts.wallet.add(myAccount);

// DEX APIs and WebSocket endpoints
const DEX_APIS = {
  uniswap: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2',
  sushiswap: 'https://api.thegraph.com/subgraphs/name/sushiswap/exchange',
  pancakeswap: 'https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v2',
  // Add more DEX endpoints as needed
};

const WEBSOCKET_ENDPOINTS = {
  uniswap: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
  sushiswap: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
  pancakeswap: 'wss://bsc-ws-node.nariox.org:443',
  // Add more WebSocket endpoints as needed
};

// Function to fetch price data from various DEXs using The Graph API
async function fetchPriceFromGraphAPI(dex, tokenAddress) {
  const query = 
    {
      pair(id: "${tokenAddress.toLowerCase()}") {
        token0 {
          id
        }
        token1 {
          id
        }
        reserve0
        reserve1
      }
    }
  ;
  const response = await axios.post(DEX_APIS[dex], { query });
  const pair = response.data.data.pair;
  if (pair) {
    const price = parseFloat(pair.reserve1) / parseFloat(pair.reserve0);
    return price;
  }
  throw new Error(Failed to fetch price from ${dex});
}

// WebSocket setup to receive real-time data
function setupWebSocket(dex, tokenAddress, callback) {
  const ws = new WebSocket(WEBSOCKET_ENDPOINTS[dex]);

  ws.on('open', () => {
    console.log(Connected to ${dex} WebSocket);
    // Subscribe to token pair updates
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: [tokenAddress],
      id: 1,
      jsonrpc: '2.0'
    }));
  });

  ws.on('message', (data) => {
    const parsedData = JSON.parse(data);
    if (parsedData && parsedData.params && parsedData.params.result) {
      const price = parseFloat(parsedData.params.result.price);
      callback(price);
    }
  });

  ws.on('error', (error) => {
    console.error(WebSocket error on ${dex}:, error);
  });

  ws.on('close', () => {
    console.log(WebSocket connection to ${dex} closed);
    // Reconnect after a delay
    setTimeout(() => setupWebSocket(dex, tokenAddress, callback), 1000); // Reduced delay for quicker reconnection
  });
}

// Function to fetch price data from multiple DEXs
async function getPriceData(tokenAddress) {
  const pricePromises = Object.keys(DEX_APIS).map(dex => fetchPriceFromGraphAPI(dex, tokenAddress));
  const prices = await Promise.all(pricePromises);
  return prices.reduce((acc, price, index) => {
    acc[Object.keys(DEX_APIS)[index]] = price;
    return acc;
  }, {});
}

// Function to calculate potential profit considering fees and slippage
function calculateProfit(price1, price2, amount) {
  const tradingFee = 0.003; // Example trading fee of 0.3%
  const gasFee = 0.01; // Example gas fee in ETH
  const profit = (price1 - price2) * amount;
  const netProfit = profit - (profit * tradingFee * 2) - gasFee;
  return netProfit;
}

// Function to detect arbitrage opportunities
async function detectArbitrage() {
  try {
    const prices = await getPriceData(process.env.TOKEN_ADDRESS);
    console.log('Prices:', prices);

    // Identify arbitrage opportunities
    const priceEntries = Object.entries(prices);
    for (let i = 0; i < priceEntries.length; i++) {
      for (let j = i + 1; j < priceEntries.length; j++) {
        const [dex1, price1] = priceEntries[i];
        const [dex2, price2] = priceEntries[j];
        const amount = 10; // Example amount to trade
        if (price1 > price2) {
          const profit = calculateProfit(price1, price2, amount);
          if (profit > 0.5) { // Ensure profit is more than $0.5
            console.log(Arbitrage opportunity detected between ${dex1} and ${dex2}! Profit: ${profit});
            // Execute flash loan and arbitrage trade
            await executeFlashLoanAndTrade(process.env.TOKEN_ADDRESS, amount, dex1, dex2, profit);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error detecting arbitrage:', error);
  }
}

// Function to execute flash loan and arbitrage trade
async function executeFlashLoanAndTrade(tokenAddress, amount, dex1, dex2, expectedProfit) {
  // Recheck the profit potential before executing the transaction
  const prices = await getPriceData(tokenAddress);
  const price1 = prices[dex1];
  const price2 = prices[dex2];
  const profit = calculateProfit(price1, price2, amount);
  
  if (profit < 0.5) {
    console.log('Profit potential decreased, transaction aborted.');
    return;
  }

  // Flash loan logic using Aave protocol
  const lendingPoolAddressProvider = new web3.eth.Contract(
    AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI,
    AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS
  );
  
  const lendingPoolAddress = await lendingPoolAddressProvider.methods.getLendingPool().call();
  const lendingPool = new web3.eth.Contract(AAVE_LENDING_POOL_ABI, lendingPoolAddress);

  const flashLoanParams = web3.eth.abi.encodeParameters(
    ['address', 'address', 'uint256', 'address', 'bytes'],
    [
      dex1, // DEX 1 address
      dex2, // DEX 2 address
      amount,
      tokenAddress,
      web3.eth.abi.encodeParameters(
        ['address', 'address', 'uint256'],
        [dex1, dex2, amount]
      )
    ]
  );

  const flashLoanTx = lendingPool.methods.flashLoan(
    myAccount.address,
    tokenAddress,
    amount,
    flashLoanParams
  );

  const gas = await flashLoanTx.estimateGas({ from: myAccount.address });
  const gasPrice = await web3.eth.getGasPrice();

  const tx = {
    from: myAccount.address,
    to: lendingPoolAddress,
    data: flashLoanTx.encodeABI(),
    gas,
    gasPrice
  };

  const receipt = await web3.eth.sendTransaction(tx);
  console.log('Flash loan executed', receipt);
}

// Function to detect sandwich opportunities
async function detectSandwich() {
  web3.eth.subscribe('pendingTransactions', async (error, txHash) => {
    if (error) console.error('Error subscribing to pending transactions:', error);
    try {
      const tx = await web3.eth.getTransaction(txHash);
      if (tx && tx.to && tx.value && tx.input && tx.input !== '0x') {
        // Decode transaction input data to identify token trade
        const inputData = web3.eth.abi.decodeParameters(['address', 'address', 'uint256'], tx.input.slice(10));
        const tokenAddress = inputData[1].toLowerCase();

        // Fetch price data before and after the transaction
        const preTxPrice = await fetchPriceFromGraphAPI('uniswap', tokenAddress); // Example DEX
        const postTxPrice = await fetchPriceFromGraphAPI('uniswap', tokenAddress); // Example DEX

        // Check if price impact is significant (e.g., more than 1%)
        if ((postTxPrice - preTxPrice) / preTxPrice > 0.01) {
          console.log('Potential sandwich opportunity detected');
          // Execute front-run and back-run trades
          executeSandwichTrade(tx, preTxPrice, postTxPrice);
        }
      }
    } catch (error) {
      console.error('Error detecting sandwich:', error);
    }
  });
}

// Function to execute sandwich trade
async function executeSandwichTrade(tx, preTxPrice, postTxPrice) {
  // Front-run trade logic here
  // ...
  // Back-run trade logic here
  // ...
}

// Real-time monitoring using WebSocket
function monitorArbitrage(tokenAddress) {
  Object.keys(WEBSOCKET_ENDPOINTS).forEach(dex => {
    setupWebSocket(dex, tokenAddress, (price) => {
      console.log(Real-time price update from ${dex}:, price);
      // Update price data and detect arbitrage in real-time
      detectArbitrage();
    });
  });
}

// Initial data fetch and regular interval checks
detectArbitrage();
setInterval(detectArbitrage, 1000); // Check every 1 second

// Start real-time monitoring for arbitrage
monitorArbitrage(process.env.TOKEN_ADDRESS);

// Start real-time monitoring for sandwich opportunities
detectSandwich();