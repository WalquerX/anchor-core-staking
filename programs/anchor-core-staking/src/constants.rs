use anchor_lang::prelude::*;

#[constant]
pub const SEED: &str = "anchor";


/// One-time bonus (in whole tokens) for burning a staked NFT
#[constant]
pub const BURN_BONUS_TOKENS: u64 = 1_000;
