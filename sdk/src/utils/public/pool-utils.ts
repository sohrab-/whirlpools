import { AddressUtil, MathUtil, Percentage } from "@orca-so/common-sdk";
import { Address, BN } from "@project-serum/anchor";
import { u64 } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { MAX_TICK_ARRAY_CROSSINGS, WhirlpoolRewardInfoData } from "../../types/public";
import { PDAUtil } from "./pda-utils";
import { PriceMath } from "./price-math";
import { TickUtil } from "./tick-utils";

/**
 * @category Whirlpool Utils
 */
export class PoolUtil {
  private constructor() {}

  public static isRewardInitialized(rewardInfo: WhirlpoolRewardInfoData): boolean {
    return (
      !PublicKey.default.equals(rewardInfo.mint) && !PublicKey.default.equals(rewardInfo.vault)
    );
  }

  public static getFeeRate(feeRate: number): Percentage {
    /**
     * Smart Contract comment: https://github.com/orca-so/whirlpool/blob/main/programs/whirlpool/src/state/whirlpool.rs#L9-L11
     * // Stored as hundredths of a basis point
     * // u16::MAX corresponds to ~6.5%
     * pub fee_rate: u16,
     */
    return Percentage.fromFraction(feeRate, 1e6); // TODO
  }

  public static getProtocolFeeRate(protocolFeeRate: number): Percentage {
    /**
     * Smart Contract comment: https://github.com/orca-so/whirlpool/blob/main/programs/whirlpool/src/state/whirlpool.rs#L13-L14
     * // Stored as a basis point
     * pub protocol_fee_rate: u16,
     */
    return Percentage.fromFraction(protocolFeeRate, 1e4); // TODO
  }

  public static orderMints(mintX: Address, mintY: Address): [Address, Address] {
    let mintA, mintB;
    if (
      Buffer.compare(
        AddressUtil.toPubKey(mintX).toBuffer(),
        AddressUtil.toPubKey(mintY).toBuffer()
      ) < 0
    ) {
      mintA = mintX;
      mintB = mintY;
    } else {
      mintA = mintY;
      mintB = mintX;
    }

    return [mintA, mintB];
  }

  /**
   * @category Whirlpool Utils
   * @param liquidity
   * @param currentPrice
   * @param lowerPrice
   * @param upperPrice
   * @param round_up
   * @returns
   */
  public static getTokenAmountsFromLiquidity(
    liquidity: u64,
    currentPrice: u64,
    lowerPrice: u64,
    upperPrice: u64,
    round_up: boolean
  ): TokenAmounts {
    const _liquidity = new Decimal(liquidity.toString());
    const _currentPrice = new Decimal(currentPrice.toString());
    const _lowerPrice = new Decimal(lowerPrice.toString());
    const _upperPrice = new Decimal(upperPrice.toString());
    let tokenA, tokenB;
    if (currentPrice.lt(lowerPrice)) {
      // x = L * (pb - pa) / (pa * pb)
      tokenA = MathUtil.toX64_Decimal(_liquidity)
        .mul(_upperPrice.sub(_lowerPrice))
        .div(_lowerPrice.mul(_upperPrice));
      tokenB = new Decimal(0);
    } else if (currentPrice.lt(upperPrice)) {
      // x = L * (pb - p) / (p * pb)
      // y = L * (p - pa)
      tokenA = MathUtil.toX64_Decimal(_liquidity)
        .mul(_upperPrice.sub(_currentPrice))
        .div(_currentPrice.mul(_upperPrice));
      tokenB = MathUtil.fromX64_Decimal(_liquidity.mul(_currentPrice.sub(_lowerPrice)));
    } else {
      // y = L * (pb - pa)
      tokenA = new Decimal(0);
      tokenB = MathUtil.fromX64_Decimal(_liquidity.mul(_upperPrice.sub(_lowerPrice)));
    }

    // TODO: round up
    if (round_up) {
      return {
        tokenA: new u64(tokenA.ceil().toString()),
        tokenB: new u64(tokenB.ceil().toString()),
      };
    } else {
      return {
        tokenA: new u64(tokenA.floor().toString()),
        tokenB: new u64(tokenB.floor().toString()),
      };
    }
  }

  /**
   * Estimate the liquidity amount required to increase/decrease liquidity.
   *
   * // TODO: At the top end of the price range, tick calcuation is off therefore the results can be off
   *
   * @category Whirlpool Utils
   * @param currTick - Whirlpool's current tick index (aka price)
   * @param lowerTick - Position lower tick index
   * @param upperTick - Position upper tick index
   * @param tokenAmount - The desired amount of tokens to deposit/withdraw
   * @returns An estimated amount of liquidity needed to deposit/withdraw the desired amount of tokens.
   */
  public static estimateLiquidityFromTokenAmounts(
    currTick: number,
    lowerTick: number,
    upperTick: number,
    tokenAmount: TokenAmounts
  ): BN {
    if (upperTick < lowerTick) {
      throw new Error("upper tick cannot be lower than the lower tick");
    }

    const currSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(currTick);
    const lowerSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(lowerTick);
    const upperSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(upperTick);

    if (currTick >= upperTick) {
      return estLiquidityForTokenB(upperSqrtPrice, lowerSqrtPrice, tokenAmount.tokenB);
    } else if (currTick < lowerTick) {
      return estLiquidityForTokenA(lowerSqrtPrice, upperSqrtPrice, tokenAmount.tokenA);
    } else {
      const estLiquidityAmountA = estLiquidityForTokenA(
        currSqrtPrice,
        upperSqrtPrice,
        tokenAmount.tokenA
      );
      const estLiquidityAmountB = estLiquidityForTokenB(
        currSqrtPrice,
        lowerSqrtPrice,
        tokenAmount.tokenB
      );
      return BN.min(estLiquidityAmountA, estLiquidityAmountB);
    }
  }

  /**
   * Given the current tick-index, returns the dervied PDA and fetched data
   * for the tick-arrays that this swap may traverse across.
   *
   * TODO: Handle the edge case where the first tick-array may be the previous array of
   * expected start-index due to slippage.
   *
   * @category Whirlpool Utils
   * @param tickCurrentIndex - The current tickIndex for the Whirlpool to swap on.
   * @param tickSpacing - The tickSpacing for the Whirlpool.
   * @param aToB - The direction of the trade.
   * @param programId - The Whirlpool programId which the Whirlpool lives on.
   * @param whirlpoolAddress - PublicKey of the whirlpool to swap on.
   * @returns An array of PublicKey[] for the tickArray accounts that this swap may traverse across.
   */
  public static getTickArrayPublicKeysForSwap(
    tickCurrentIndex: number,
    tickSpacing: number,
    aToB: boolean,
    programId: PublicKey,
    whirlpoolAddress: PublicKey
  ) {
    let offset = 0;
    let tickArrayAddresses: PublicKey[] = [];
    for (let i = 0; i <= MAX_TICK_ARRAY_CROSSINGS; i++) {
      const startIndex = TickUtil.getStartTickIndex(tickCurrentIndex, tickSpacing, offset);
      const pda = PDAUtil.getTickArray(programId, whirlpoolAddress, startIndex);
      tickArrayAddresses.push(pda.publicKey);
      offset = aToB ? offset - 1 : offset + 1;
    }

    return tickArrayAddresses;
  }
}

/**
 * @category Whirlpool Utils
 */
export type TokenAmounts = {
  tokenA: u64;
  tokenB: u64;
};

/**
 * @category Whirlpool Utils
 */
export function toTokenAmount(a: number, b: number): TokenAmounts {
  return {
    tokenA: new u64(a.toString()),
    tokenB: new u64(b.toString()),
  };
}

// Convert this function based on Delta A = Delta L * (1/sqrt(lower) - 1/sqrt(upper))
function estLiquidityForTokenA(sqrtPrice1: BN, sqrtPrice2: BN, tokenAmount: u64) {
  const lowerSqrtPriceX64 = BN.min(sqrtPrice1, sqrtPrice2);
  const upperSqrtPriceX64 = BN.max(sqrtPrice1, sqrtPrice2);

  const num = MathUtil.fromX64_BN(tokenAmount.mul(upperSqrtPriceX64).mul(lowerSqrtPriceX64));
  const dem = upperSqrtPriceX64.sub(lowerSqrtPriceX64);

  return num.div(dem);
}

// Convert this function based on Delta B = Delta L * (sqrt_price(upper) - sqrt_price(lower))
function estLiquidityForTokenB(sqrtPrice1: BN, sqrtPrice2: BN, tokenAmount: u64) {
  const lowerSqrtPriceX64 = BN.min(sqrtPrice1, sqrtPrice2);
  const upperSqrtPriceX64 = BN.max(sqrtPrice1, sqrtPrice2);

  const delta = upperSqrtPriceX64.sub(lowerSqrtPriceX64);

  return MathUtil.toX64_BN(tokenAmount).div(delta);
}
