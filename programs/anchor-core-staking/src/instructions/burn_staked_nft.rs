use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token_interface::{Mint, TokenAccount, TokenInterface, mint_to_checked, MintToChecked}};
use mpl_core::{
    ID as MPL_CORE_ID,
    accounts::{BaseAssetV1, BaseCollectionV1},
    types::{UpdateAuthority, Attributes, FreezeDelegate, Plugin, PluginType},
    instructions::{BurnV1CpiBuilder, UpdatePluginV1CpiBuilder},
    fetch_plugin,
};
use crate::constants::BURN_BONUS_TOKENS;
use crate::Config;
use crate::error::ErrorCode;

const SECONDS_PER_DAY: i64 = 86400;

#[derive(Accounts)]
pub struct BurnStakedNft<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"config", collection.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = owner @ ErrorCode::InvalidOwner,
        constraint = asset.update_authority == UpdateAuthority::Collection(collection.key()) @ ErrorCode::InvalidUpdateAuthority,
    )]
    pub asset: Account<'info, BaseAssetV1>,
    #[account(
        mut,
        has_one = update_authority @ ErrorCode::InvalidUpdateAuthority
    )]
    pub collection: Account<'info, BaseCollectionV1>,
    /// CHECK: This account data is not used, we only verify the address
    #[account(
        seeds = [b"update_authority", collection.key().as_ref()],
        bump,
    )]
    pub update_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"rewards_mint", config.key().as_ref()],
        bump = config.rewards_bump,
    )]
    pub rewards_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = rewards_mint,
        associated_token::authority = owner,
    )]
    pub user_rewards_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: This is the MPL Core program
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<BurnStakedNft>) -> Result<()> {

    // 1. Read the attributes. The asset must be staked.
    let attributes: Attributes = fetch_plugin::<BaseAssetV1, Attributes>(
        &ctx.accounts.asset.to_account_info(),
        PluginType::Attributes,
    )
    .map_err(|_| ErrorCode::AssetNotStaked)?
    .1;

    let mut staked = false;
    let mut staked_at: Option<i64> = None;
    let mut last_claimed_at: Option<i64> = None;

    for attribute in &attributes.attribute_list {
        match attribute.key.as_str() {
            "staked" => staked = attribute.value == "true",
            "staked_at" => {
                staked_at = Some(attribute.value.parse::<i64>().map_err(|_| ErrorCode::InvalidTimestamp)?)
            }
            "last_claimed_at" => {
                last_claimed_at = Some(attribute.value.parse::<i64>().map_err(|_| ErrorCode::InvalidTimestamp)?)
            }
            _ => {}
        }
    }

    require!(staked, ErrorCode::AssetNotStaked);
    let staked_at = staked_at.ok_or(ErrorCode::InvalidTimestamp)?;
    let last_claimed_at = last_claimed_at.unwrap_or(staked_at);

    // 2. Same freeze period as unstake.
    //    This stops "stake, then burn at once" for the bonus.
    let now = Clock::get()?.unix_timestamp;
    let days_staked = now
        .checked_sub(staked_at)
        .ok_or(ErrorCode::InvalidTimestamp)?
        / SECONDS_PER_DAY;
    require!(days_staked >= ctx.accounts.config.freeze_period as i64, ErrorCode::FreezePeriodNotElapsed);

    // 3. Payout = unclaimed rewards + one-time bonus
    let decimals = ctx.accounts.rewards_mint.decimals;
    let unclaimed_days = now
        .checked_sub(last_claimed_at)
        .ok_or(ErrorCode::InvalidTimestamp)?
        / SECONDS_PER_DAY;
    require!(unclaimed_days >= 0, ErrorCode::InvalidTimestamp);

    let unclaimed = (unclaimed_days as u64)
        .checked_mul(ctx.accounts.config.rewards_bps as u64)
        .ok_or(ErrorCode::InvalidRewardsBps)?
        .checked_mul(10u64.pow(decimals as u32))
        .ok_or(ErrorCode::InvalidRewardsBps)?
        .checked_div(10000u64)
        .ok_or(ErrorCode::InvalidRewardsBps)?;
    let bonus = BURN_BONUS_TOKENS
        .checked_mul(10u64.pow(decimals as u32))
        .ok_or(ErrorCode::InvalidRewardsBps)?;
    let amount = unclaimed.checked_add(bonus).ok_or(ErrorCode::InvalidRewardsBps)?;

    let collection_key = ctx.accounts.collection.key();
    let signer_seeds = &[
        b"update_authority",
        collection_key.as_ref(),
        &[ctx.bumps.update_authority],
    ];

    // 4. Thaw. A frozen FreezeDelegate rejects the burn, and the
    //    BurnDelegate approval cannot override a rejection.
    UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
    .asset(&ctx.accounts.asset.to_account_info())
    .collection(Some(&ctx.accounts.collection.to_account_info()))
    .payer(&ctx.accounts.owner.to_account_info())
    .authority(Some(&ctx.accounts.update_authority.to_account_info()))
    .system_program(&ctx.accounts.system_program.to_account_info())
    .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false }))
    .invoke_signed(&[signer_seeds])?;

    // 5. Burn. The update authority PDA signs as the BurnDelegate.
    BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
    .asset(&ctx.accounts.asset.to_account_info())
    .collection(Some(&ctx.accounts.collection.to_account_info()))
    .payer(&ctx.accounts.owner.to_account_info())
    .authority(Some(&ctx.accounts.update_authority.to_account_info()))
    .system_program(Some(&ctx.accounts.system_program.to_account_info()))
    .invoke_signed(&[signer_seeds])?;

    // 6. Mint unclaimed rewards + bonus. The config PDA is the mint authority.
    let config_seeds = &[
        b"config",
        collection_key.as_ref(),
        &[ctx.accounts.config.bump],
    ];
    let config_signer_seeds = &[&config_seeds[..]];

    mint_to_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintToChecked {
                mint: ctx.accounts.rewards_mint.to_account_info(),
                to: ctx.accounts.user_rewards_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            config_signer_seeds,
        ),
        amount,
        decimals,
    )?;

    // 7. Collection stats: total_staked -= 1
    crate::utils::update_total_staked(
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.collection.to_account_info(),
        &ctx.accounts.update_authority.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        signer_seeds,
        false,
    )?;

    Ok(())
}