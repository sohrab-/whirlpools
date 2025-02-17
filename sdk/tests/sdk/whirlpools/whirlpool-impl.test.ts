import * as assert from "assert";
import * as anchor from "@project-serum/anchor";
import { WhirlpoolContext } from "../../../src/context";
import { initTestPool } from "../../utils/init-utils";
import { getTokenBalance, ONE_SOL, systemTransferTx, TickSpacing } from "../../utils";
import {
  AccountFetcher,
  buildWhirlpoolClient,
  increaseLiquidityQuoteByInputToken,
  PDAUtil,
  PriceMath,
  TickUtil,
} from "../../../src";
import Decimal from "decimal.js";
import { Percentage } from "@orca-so/common-sdk";
import { mintTokensToTestAccount } from "../../utils/test-builders";

describe("whirlpool-impl", () => {
  const provider = anchor.Provider.local();
  anchor.setProvider(anchor.Provider.env());
  const program = anchor.workspace.Whirlpool;
  const ctx = WhirlpoolContext.fromWorkspace(provider, program);
  const fetcher = new AccountFetcher(ctx.connection);
  const client = buildWhirlpoolClient(ctx, fetcher);

  it("open and add liquidity to a position, then close", async () => {
    const funderKeypair = anchor.web3.Keypair.generate();
    await systemTransferTx(provider, funderKeypair.publicKey, ONE_SOL).buildAndExecute();

    const { poolInitInfo } = await initTestPool(
      ctx,
      TickSpacing.Standard,
      PriceMath.priceToSqrtPriceX64(new Decimal(100), 6, 6)
    );
    const pool = await client.getPool(poolInitInfo.whirlpoolPda.publicKey);

    // Verify token mint info is correct
    const tokenAInfo = pool.getTokenAInfo();
    const tokenBInfo = pool.getTokenBInfo();
    assert.ok(tokenAInfo.mint.equals(poolInitInfo.tokenMintA));
    assert.ok(tokenBInfo.mint.equals(poolInitInfo.tokenMintB));

    // Create and mint tokens in this wallet
    const mintedTokenAmount = 150_000_000;
    const [userTokenAAccount, userTokenBAccount] = await mintTokensToTestAccount(
      ctx.provider,
      tokenAInfo.mint,
      mintedTokenAmount,
      tokenBInfo.mint,
      mintedTokenAmount
    );

    // Open a position with no tick arrays initialized.
    const lowerPrice = new Decimal(96);
    const upperPrice = new Decimal(101);
    const poolData = pool.getData();
    const tokenADecimal = tokenAInfo.decimals;
    const tokenBDecimal = tokenBInfo.decimals;

    const tickLower = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(lowerPrice, tokenADecimal, tokenBDecimal),
      poolData.tickSpacing
    );
    const tickUpper = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(upperPrice, tokenADecimal, tokenBDecimal),
      poolData.tickSpacing
    );

    const inputTokenMint = poolData.tokenMintA;
    const quote = increaseLiquidityQuoteByInputToken(
      inputTokenMint,
      new Decimal(50),
      tickLower,
      tickUpper,
      Percentage.fromFraction(1, 100),
      pool
    );

    // [Action] Initialize Tick Arrays
    const initTickArrayTx = await pool.initTickArrayForTicks(
      [tickLower, tickUpper],
      funderKeypair.publicKey
    );
    await initTickArrayTx.addSigner(funderKeypair).buildAndExecute();

    // [Action] Open Position (and increase L)
    const { positionMint, tx } = await pool.openPosition(
      tickLower,
      tickUpper,
      quote,
      ctx.wallet.publicKey,
      ctx.wallet.publicKey,
      funderKeypair.publicKey
    );

    await tx.addSigner(funderKeypair).buildAndExecute();

    // Verify position exists and numbers fit input parameters
    const positionAddress = PDAUtil.getPosition(ctx.program.programId, positionMint).publicKey;
    const position = await client.getPosition(positionAddress);
    const positionData = position.getData();

    const tickLowerIndex = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(lowerPrice, tokenAInfo.decimals, tokenBInfo.decimals),
      poolData.tickSpacing
    );
    const tickUpperIndex = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(upperPrice, tokenAInfo.decimals, tokenBInfo.decimals),
      poolData.tickSpacing
    );
    assert.ok(positionData.liquidity.eq(quote.liquidityAmount));
    assert.ok(positionData.tickLowerIndex === tickLowerIndex);
    assert.ok(positionData.tickUpperIndex === tickUpperIndex);
    assert.ok(positionData.positionMint.equals(positionMint));
    assert.ok(positionData.whirlpool.equals(poolInitInfo.whirlpoolPda.publicKey));

    // [Action] Close Position
    await (
      await pool.closePosition(positionAddress, Percentage.fromFraction(1, 100))
    ).buildAndExecute();

    // Verify position is closed and owner wallet has the tokens back
    const postClosePosition = await fetcher.getPosition(positionAddress, true);
    assert.ok(postClosePosition === null);

    // TODO: we are leaking 1 decimal place of token?
    assert.equal(await getTokenBalance(ctx.provider, userTokenAAccount), mintedTokenAmount - 1);
    assert.equal(await getTokenBalance(ctx.provider, userTokenBAccount), mintedTokenAmount - 1);
  });
});
