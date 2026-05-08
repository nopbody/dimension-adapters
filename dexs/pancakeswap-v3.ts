import { cache } from "@defillama/sdk";
import axios from "axios";
import { ethers } from "ethers";
import { BaseAdapter, Dependencies, FetchOptions, IJSON, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { queryDune } from "../helpers/dune";
import { getDefaultDexTokensWhitelisted } from "../helpers/lists";
import { getUniV3LogAdapter } from '../helpers/uniswap';

const poolCreatedEvent = 'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
const poolSwapEvent = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)'

interface Ifactory {
  address: string;
  start: string;
}

const factories: {[key: string]: Ifactory} = {
  [CHAIN.BSC]: {
    start: '2023-04-01',
    address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  },
  [CHAIN.ETHEREUM]: {
    start: '2023-04-01',
    address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  },
  [CHAIN.POLYGON_ZKEVM]: {
    start: '2023-06-08',
    address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  },
  [CHAIN.ERA]: {
    start: '2023-07-24',
    address: '0x1bb72e0cbbea93c08f535fc7856e0338d7f7a8ab',
  },
  [CHAIN.ARBITRUM]: {
    start: '2023-08-08',
    address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  },
  [CHAIN.LINEA]: {
    start: '2023-08-24',
    address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  },
  [CHAIN.BASE]: {
    start: '2023-08-21',
    address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  },
  [CHAIN.OP_BNB]: {
    start: '2023-08-31',
    address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  },
  [CHAIN.MONAD]: {
    start: '2025-11-23',
    address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
  }
}

export const PANCAKESWAP_V3_QUERY = async (fromTime: number, toTime: number) => {
  const tokens = await getDefaultDexTokensWhitelisted({ chain: CHAIN.BSC });
  return `
    SELECT
        project_contract_address AS pool
        , SUM(
          CASE 
              WHEN token_sold_address IN (${tokens.toString()})
              AND token_bought_address IN (${tokens.toString()})
              THEN amount_usd
              ELSE 0
          END
        ) AS clean_volume_usd
        , SUM(amount_usd) AS total_volume_usd 
    FROM dex.trades
    WHERE blockchain = 'bnb'
      AND project = 'pancakeswap'
      AND version = '3'
      AND block_time >= FROM_UNIXTIME(${fromTime})
      AND block_time <= FROM_UNIXTIME(${toTime})
    GROUP BY
      project_contract_address
  `;
}

export const PANCAKESWAP_V3_QUERY_SOLANA = (fromTime: number, toTime: number) => {
  return `
    SELECT
      project_program_id AS pool
      , SUM(amount_usd) AS volume_usd
    FROM dex_solana.trades
    WHERE project = 'pancakeswap'
      AND version = 3
      AND block_time >= FROM_UNIXTIME(${fromTime})
      AND block_time <= FROM_UNIXTIME(${toTime})
    GROUP BY
      project_program_id
  `;
}

// Source: https://docs.pancakeswap.finance/trade/trading-faq/swap-faq#what-will-be-the-trading-fee-breakdown-for-v3-exchange
function getProtocolRevenueRatio(fee: number): number {
  if (fee === 0.0001) return 0.18; // 18% swap fee
  if (fee === 0.0005) return 0.19; // 19% swap fee
  if (fee === 0.0025) return 0.09; // 9% swap fee
  if (fee === 0.01) return 0.09; // 9% swap fee
  return 0;
}

function getHolderRevenueRatio(fee: number): number {
  if (fee === 0.0001) return 0.15; // 15% swap fee
  if (fee === 0.0005) return 0.15; // 15% swap fee
  if (fee === 0.0025) return 0.23; // 23% swap fee
  if (fee === 0.01) return 0.23; // 23% swap fee
  return 0;
}

const getRevenueBreakdown = (fee: number) => {
  const protocolRevenueRatio = getProtocolRevenueRatio(fee)
  const holdersRevenueRatio = getHolderRevenueRatio(fee)
  const revenueRatio = protocolRevenueRatio + holdersRevenueRatio

  return {
    protocolRevenueRatio,
    holdersRevenueRatio,
    revenueRatio,
    supplySideRevenueRatio: 1 - revenueRatio,
  }
}

const getCachedPoolMetadata = async (chain: string) => {
  const factory = factories[chain]
  if (!factory) throw new Error(`Unsupported chain: ${chain}`)

  const cacheKey = `tvl-adapter-cache/cache/logs/${chain}/${factory.address.toLowerCase()}.json`
  const iface = new ethers.Interface([poolCreatedEvent])
  let { logs } = await cache.readCache(cacheKey, { readFromR2Cache: true })
  if (!logs?.length) throw new Error('No pairs found, is there TVL adapter for this already?')
  logs = logs.map((log: any) => iface.parseLog(log)?.args).filter((log: any) => !!log)

  const pairObject: IJSON<string[]> = {}
  const fees: Record<string, number> = {}
  logs.forEach((log: any) => {
    const pool = String(log.pool).toLowerCase()
    pairObject[pool] = [log.token0, log.token1]
    fees[pool] = Number(log.fee?.toString() || 0) / 1e6
  })

  return { pairObject, fees }
}

const fetchBscV3 = async (options: FetchOptions) => {
  const { fees } = await getCachedPoolMetadata(options.chain)

  const dailyVolume = options.createBalances()
  const dailyFees = options.createBalances()
  const dailyRevenue = options.createBalances()
  const dailyProtocolRevenue = options.createBalances()
  const dailyHoldersRevenue = options.createBalances()
  const dailySupplySideRevenue = options.createBalances()

  const poolsAndVolumes = await queryDune('3996608', {
    fullQuery: await PANCAKESWAP_V3_QUERY(options.fromTimestamp, options.toTimestamp),
  }, options)

  for (const poolVolume of poolsAndVolumes) {
    if (poolVolume.clean_volume_usd === null || poolVolume.total_volume_usd === null) continue

    const cleanVolumeUsd = Number(poolVolume.clean_volume_usd)
    const totalVolumeUsd = Number(poolVolume.total_volume_usd)
    const fee = fees[String(poolVolume.pool).toLowerCase()] ?? 0
    const { protocolRevenueRatio, holdersRevenueRatio, revenueRatio, supplySideRevenueRatio } = getRevenueBreakdown(fee)
    const feeUsd = totalVolumeUsd * fee

    dailyVolume.addUSDValue(cleanVolumeUsd)
    dailyFees.addUSDValue(feeUsd)
    dailyRevenue.addUSDValue(feeUsd * revenueRatio)
    dailyProtocolRevenue.addUSDValue(feeUsd * protocolRevenueRatio)
    dailyHoldersRevenue.addUSDValue(feeUsd * holdersRevenueRatio)
    dailySupplySideRevenue.addUSDValue(feeUsd * supplySideRevenueRatio)
  }

  return { dailyVolume, dailyFees, dailyUserFees: dailyFees, dailyRevenue, dailySupplySideRevenue, dailyProtocolRevenue, dailyHoldersRevenue }
}

const pancakeSolanaExplorer = 'https://sol-explorer.pancakeswap.com/api/cached/v1/pools/info/list?poolType=concentrated&poolSortField=default&order=desc'
const blacklistPools = [
  'EbkGwrT4zf7Hczrn23zyoPJHThd2NHguJnyWiJe9wf9D',
]

const fetchSolanaV3 = async (options: FetchOptions) => {
  let dailyVolume = 0
  let dailyFees = 0
  let dailyProtocolRevenue = 0
  let dailyHoldersRevenue = 0
  let dailySupplySideRevenue = 0

  let page = 1
  const allPools: Array<any> = []
  while (true) {
    const response = await axios.get(`${pancakeSolanaExplorer}&pageSize=100&page=${page}`)
    const pools = response.data.data
    if (!pools.length) break

    allPools.push(...pools)
    page += 1
  }

  const todayTimestamp = Math.floor(Date.now() / 1000)
  const useDuneBackfill = options.startOfDay < todayTimestamp - 48 * 3600
  let historicalVolumeByPool = new Map<string, number>()

  if (useDuneBackfill) {
    const poolsAndVolumes = await queryDune('3996608', {
      fullQuery: PANCAKESWAP_V3_QUERY_SOLANA(options.fromTimestamp, options.toTimestamp),
    }, options)
    historicalVolumeByPool = new Map(
      poolsAndVolumes.map((item: any) => [item.pool, Number(item.volume_usd)])
    )
  }

  for (const pool of allPools) {
    if (blacklistPools.includes(pool.id)) continue

    const feeRate = pool.feeRate ? Number(pool.feeRate) : 0
    const volume = useDuneBackfill ? historicalVolumeByPool.get(pool.id) ?? 0 : Number(pool.day.volume)
    const fee = useDuneBackfill ? volume * feeRate : Number(pool.day.volumeFee)
    const { protocolRevenueRatio, holdersRevenueRatio, supplySideRevenueRatio } = getRevenueBreakdown(feeRate)

    dailyVolume += volume
    dailyFees += fee
    dailyProtocolRevenue += fee * protocolRevenueRatio
    dailyHoldersRevenue += fee * holdersRevenueRatio
    dailySupplySideRevenue += fee * supplySideRevenueRatio
  }

  return {
    dailyVolume,
    dailyFees,
    dailyUserFees: dailyFees,
    dailyRevenue: dailyProtocolRevenue + dailyHoldersRevenue,
    dailyProtocolRevenue,
    dailyHoldersRevenue,
    dailySupplySideRevenue,
  }
}

const pancakeV3Adapter = Object.entries(factories).reduce((acc, [chain, config]) => {
  acc[chain] = {
    fetch: chain === CHAIN.BSC
      ? fetchBscV3
      : getUniV3LogAdapter({
        factory: config.address,
        poolCreatedEvent,
        swapEvent: poolSwapEvent,
        userFeesRatio: 1,
        getFeeBreakdown: (fee: number) => getRevenueBreakdown(fee),
      }),
    start: config.start,
  }

  return acc
}, {
  [CHAIN.SOLANA]: {
    fetch: fetchSolanaV3,
    start: '2025-07-11',
  },
} as BaseAdapter)

const methodology = {
  Fees: "Total trading fees - sum of LP fees and protocol fees. LP fees vary by pool type (0.25% for most pools, with some special pools having different rates). Protocol fees are 0.05% for most pools.",
  UserFees: "All trading fees paid by users",
  Revenue: "Pancakeswap collects amount of swap fees for Treasury and buy back CAKE.",
  SupplySideRevenue: "Fees distributed to LPs",
  ProtocolRevenue: "Swap fees collected by Pancakeswap - distribute to Treasury",
  HoldersRevenue: "Swap fees collected by Pancakeswap used for buyback and burn CAKE",
}

const adapter: SimpleAdapter = {
  version: 2,
  isExpensiveAdapter: true,
  dependencies: [Dependencies.DUNE],
  methodology,
  adapter: pancakeV3Adapter,
}

export default adapter;