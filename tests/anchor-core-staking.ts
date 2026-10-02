import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorCoreStaking } from "../target/types/anchor_core_staking";
import { SystemProgram } from "@solana/web3.js";
import { MPL_CORE_PROGRAM_ID, mplCore, fetchAsset, fetchCollection } from "@metaplex-foundation/mpl-core";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey } from "@metaplex-foundation/umi";
import { assert } from "chai";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const MILLISECONDS_PER_DAY = 86400000;
const REWARDS_BPS = 10000;
const FREEZE_PERIOD_IN_DAYS = 7;
const TIME_TRAVEL_IN_DAYS = 8;

describe("anchor-core-staking", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.anchorCoreStaking as Program<AnchorCoreStaking>;

  const umi = createUmi(provider.connection.rpcEndpoint).use(mplCore());

  const rewardAccounts = () => ({
    owner: provider.wallet.publicKey,
    updateAuthority,
    config,
    rewardsMint,
    userRewardsAta: getAssociatedTokenAddressSync(rewardsMint, provider.wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    asset: nftKeypair.publicKey,
    collection: collectionKeypair.publicKey,
    mplCoreProgram: MPL_CORE_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  });

  async function expectError(p: Promise<any>, code: string) {
    try {
      const tx = await p;
      throw new Error(`Expected ${code}, but tx succeeded: ${tx}`);
    } catch (err) {
      if (err instanceof anchor.AnchorError && err.error.errorCode.code === code) {
        console.log(`\nFailed as expected: ${code}`);
        return;
      }
      throw err;
    }
  }

  async function totalStaked(): Promise<string | undefined> {
    const collection = await fetchCollection(umi, publicKey(collectionKeypair.publicKey.toBase58()));
    return collection.attributes?.attributeList.find((a) => a.key === "total_staked")?.value;
  }

  // Generate a keypair for the collection
  const collectionKeypair = anchor.web3.Keypair.generate();

  // Find the update authority for the collection (PDA)
  const updateAuthority = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("update_authority"), collectionKeypair.publicKey.toBuffer()],
    program.programId
  )[0];

  // Generate a keypair for the nft asset
  const nftKeypair = anchor.web3.Keypair.generate();

  // Find the config account (PDA)
  const config = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config"), collectionKeypair.publicKey.toBuffer()],
    program.programId
  )[0];

  // Find the rewards mint account (PDA)
  const rewardsMint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_mint"), config.toBuffer()],
    program.programId
  )[0];

  // Helper function to advance time with Surfpool 
  async function advanceTime(params: { absoluteEpoch?: number; absoluteSlot?: number; absoluteTimestamp?: number }): Promise<void> {
    const rpcResponse = await fetch(provider.connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [params],
      }),
    });

    const result = await rpcResponse.json() as { error?: any; result?: any };
    if (result.error) {
      throw new Error(`Time travel failed: ${JSON.stringify(result.error)}`);
    }
    
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  it("Create a collection", async () => {
    const collectionName = "Test Collection";
    const collectionUri = "https://example.com/collection";
    const tx = await program.methods.createCollection(collectionName, collectionUri)
    .accountsPartial({
      payer: provider.wallet.publicKey,
      collection: collectionKeypair.publicKey,
      updateAuthority,
      systemProgram: SystemProgram.programId,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
    })
    .signers([collectionKeypair])
    .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("Collection address", collectionKeypair.publicKey.toBase58());
  });

  it("Mint an NFT", async () => {
    const nftName = "Test NFT";
    const nftUri = "https://example.com/nft";
    const tx = await program.methods.mintAsset(nftName, nftUri)
    .accountsPartial({
      user: provider.wallet.publicKey,
      asset: nftKeypair.publicKey,
      collection: collectionKeypair.publicKey,
      updateAuthority,
      systemProgram: SystemProgram.programId,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
    })
    .signers([nftKeypair])
    .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("NFT address", nftKeypair.publicKey.toBase58());
  });

  it("Initialize Config", async () => {
    const tx = await program.methods.initialize(REWARDS_BPS, FREEZE_PERIOD_IN_DAYS)
    .accountsPartial({
      admin: provider.wallet.publicKey,
      collection: collectionKeypair.publicKey,
      updateAuthority,
      config,
      rewardsMint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("Config address", config.toBase58());
    console.log("Rewards BPS", REWARDS_BPS);
    console.log("Freeze period in days", FREEZE_PERIOD_IN_DAYS);
    console.log("Rewards mint address", rewardsMint.toBase58());
  });

  it("Stake an NFT", async () => {
    const tx = await program.methods.stake()
    .accountsPartial({
      owner: provider.wallet.publicKey,
      updateAuthority,
      config,
      asset: nftKeypair.publicKey,
      collection: collectionKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
    })
    .rpc();
    console.log("\nYour transaction signature", tx);

    const asset = await fetchAsset(umi, publicKey(nftKeypair.publicKey.toBase58()));
    const attrs = asset.attributes?.attributeList ?? [];
    const get = (k: string) => attrs.find((a) => a.key === k)?.value;
    assert.equal(get("staked"), "true");
    assert.equal(get("last_claimed_at"), get("staked_at"));
    console.log("Asset attributes", attrs);

    assert.equal(await totalStaked(), "1");

    const stakedAsset = await fetchAsset(umi, publicKey(nftKeypair.publicKey.toBase58()));
    assert.exists(stakedAsset.burnDelegate, "BurnDelegate must be added");
  });

  it("Try to unstake an NFT before the freeze period ends", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(rewardsMint, provider.wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
      const tx = await program.methods.unstake()
      .accountsPartial({
        owner: provider.wallet.publicKey,
        updateAuthority,
        config,
        rewardsMint,
        userRewardsAta,
        asset: nftKeypair.publicKey,
        collection: collectionKeypair.publicKey,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();
      throw new Error(`Unstake should have failed before freeze period elapsed, but succeeded with tx: ${tx}`);
    } catch (err) {
      if (err instanceof anchor.AnchorError && err.error.errorCode.code === "FreezePeriodNotElapsed") {
        console.log("\nUnstake failed as expected:", err.error.errorMessage);
      } else {
        throw err;
      }
    }
  });

  it("Claim before one full day fails", async () => {
    await expectError(program.methods.claimRewards().accountsPartial(rewardAccounts()).rpc(), "NothingToClaim");
  });

  it("Time travel to the future", async () => {
    // Advance time in milliseconds
    const currentTimestamp = Date.now();
    await advanceTime({ absoluteTimestamp: currentTimestamp + TIME_TRAVEL_IN_DAYS * MILLISECONDS_PER_DAY });
    console.log("\nTime traveled in days", TIME_TRAVEL_IN_DAYS)
  });

  it("Claim rewards without unstaking", async () => {
    const accounts = rewardAccounts();
    await program.methods.claimRewards().accountsPartial(accounts).rpc();

    const balance = (await provider.connection.getTokenAccountBalance(accounts.userRewardsAta)).value.uiAmount;
    assert.equal(balance, 8);

    const asset = await fetchAsset(umi, publicKey(nftKeypair.publicKey.toBase58()));
    assert.isTrue(asset.freezeDelegate?.frozen, "NFT must stay frozen");
    const staked = asset.attributes?.attributeList.find((a) => a.key === "staked")?.value;
    assert.equal(staked, "true");
    console.log("Rewards after claim", balance);

    assert.equal(await totalStaked(), "1");
  });

  it("Claim again at once fails (no double claim)", async () => {
    await expectError(program.methods.claimRewards().accountsPartial(rewardAccounts()).rpc(), "NothingToClaim");
  });

  it("Unstake an NFT", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(rewardsMint, provider.wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const tx = await program.methods.unstake()
    .accountsPartial({
      owner: provider.wallet.publicKey,
      updateAuthority,
      config,
      rewardsMint,
      userRewardsAta,
      asset: nftKeypair.publicKey,
      collection: collectionKeypair.publicKey,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("User rewards balance", (await provider.connection.getTokenAccountBalance(userRewardsAta)).value.uiAmount);

    const balance = (await provider.connection.getTokenAccountBalance(userRewardsAta)).value.uiAmount;
    assert.equal(balance, 8, "unstake must not pay claimed days again");

    const asset = await fetchAsset(umi, publicKey(nftKeypair.publicKey.toBase58()));
    assert.notExists(asset.freezeDelegate, "FreezeDelegate must be removed");

    assert.equal(await totalStaked(), "0");

    assert.notExists(asset.burnDelegate, "BurnDelegate must be removed");
  });

  it("Claim on an unstaked NFT fails", async () => {
    await expectError(program.methods.claimRewards().accountsPartial(rewardAccounts()).rpc(), "AssetNotStaked");
  });

  it("Stake the same NFT again", async () => {
    await program.methods.stake()
    .accountsPartial({
      owner: provider.wallet.publicKey,
      updateAuthority,
      config,
      asset: nftKeypair.publicKey,
      collection: collectionKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
    })
    .rpc();

    const asset = await fetchAsset(umi, publicKey(nftKeypair.publicKey.toBase58()));
    assert.isTrue(asset.freezeDelegate?.frozen, "NFT must be frozen again");

    assert.equal(await totalStaked(), "1");

    assert.exists(asset.burnDelegate, "BurnDelegate must be added again");
  });
});
