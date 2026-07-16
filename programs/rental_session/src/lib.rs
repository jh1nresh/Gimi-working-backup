use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("AVL316tYxrg8MhEeWtaxbwdShMWybzRAH1zNQWvX355K");

const BPS_DENOMINATOR: u64 = 10_000;
const MAX_PLATFORM_FEE_BPS: u16 = 2_000;
const MAX_RENTAL_SECONDS: i64 = 60 * 60 * 24 * 30;
const PLATFORM_AUTHORITY: Pubkey = pubkey!("7Fmr5t2h2SZ55n4w3dkgWTjaXRafDnBLLy1RhdmPJk6b");

pub const ITEM_STATUS_AVAILABLE: u8 = 0;
pub const ITEM_STATUS_RENTED: u8 = 1;
pub const ITEM_STATUS_BUYOUT: u8 = 2;

pub const SESSION_STATUS_ACTIVE: u8 = 0;
pub const SESSION_STATUS_RETURNED: u8 = 1;
pub const SESSION_STATUS_BUYOUT: u8 = 2;

pub const RENTAL_TOKEN_STATUS_ACTIVE: u8 = 0;
pub const RENTAL_TOKEN_STATUS_BURNED: u8 = 1;

#[program]
pub mod rental_session {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_PLATFORM_FEE_BPS, RentProofError::FeeTooHigh);
        require!(
            ctx.accounts.authority.key() == PLATFORM_AUTHORITY,
            RentProofError::InvalidPlatformAuthority
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_authority = ctx.accounts.fee_authority.key();
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            authority: config.authority,
            fee_authority: config.fee_authority,
            fee_bps,
        });

        Ok(())
    }

    pub fn initialize_item(
        ctx: Context<InitializeItem>,
        item_id: [u8; 32],
        metadata_hash: [u8; 32],
        rate_per_second: u64,
        minimum_fee: u64,
        buyout_cap: u64,
        auto_buyout_grace_seconds: i64,
    ) -> Result<()> {
        require!(rate_per_second > 0, RentProofError::InvalidPricing);
        require!(minimum_fee > 0, RentProofError::InvalidPricing);
        require!(buyout_cap >= minimum_fee, RentProofError::InvalidPricing);
        require!(auto_buyout_grace_seconds >= 0, RentProofError::InvalidRentalWindow);

        let item = &mut ctx.accounts.item;
        item.owner = ctx.accounts.owner.key();
        item.payment_mint = ctx.accounts.payment_mint.key();
        item.item_id = item_id;
        item.metadata_hash = metadata_hash;
        item.rate_per_second = rate_per_second;
        item.minimum_fee = minimum_fee;
        item.buyout_cap = buyout_cap;
        item.auto_buyout_grace_seconds = auto_buyout_grace_seconds;
        item.active_session = Pubkey::default();
        item.status = ITEM_STATUS_AVAILABLE;
        item.bump = ctx.bumps.item;

        emit!(ItemInitialized {
            item: item.key(),
            owner: item.owner,
            payment_mint: item.payment_mint,
            buyout_cap,
        });

        Ok(())
    }

    pub fn start_rental(
        ctx: Context<StartRental>,
        rental_id: [u8; 32],
        rental_seconds: i64,
    ) -> Result<()> {
        require!(rental_seconds > 0, RentProofError::InvalidRentalWindow);
        require!(rental_seconds <= MAX_RENTAL_SECONDS, RentProofError::InvalidRentalWindow);
        require!(
            ctx.accounts.item.status == ITEM_STATUS_AVAILABLE,
            RentProofError::ItemUnavailable
        );

        let clock = Clock::get()?;
        let item = &mut ctx.accounts.item;
        let expected_fee = calculate_fee(item, rental_seconds)?;
        let escrow_amount = item.buyout_cap;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.renter_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.renter.to_account_info(),
                },
            ),
            escrow_amount,
        )?;

        let session = &mut ctx.accounts.session;
        session.item = item.key();
        session.renter = ctx.accounts.renter.key();
        session.owner = item.owner;
        session.payment_mint = item.payment_mint;
        session.rental_id = rental_id;
        session.start_ts = clock.unix_timestamp;
        session.due_ts = clock
            .unix_timestamp
            .checked_add(rental_seconds)
            .ok_or(RentProofError::MathOverflow)?;
        session.returned_ts = 0;
        session.escrow_amount = escrow_amount;
        session.expected_fee_at_start = expected_fee;
        session.final_fee = 0;
        session.owner_payout = 0;
        session.platform_fee = 0;
        session.renter_refund = 0;
        session.return_requested_ts = 0;
        session.status = SESSION_STATUS_ACTIVE;
        session.bump = ctx.bumps.session;
        session.escrow_bump = ctx.bumps.escrow_authority;
        session.rental_token_bump = ctx.bumps.rental_token;

        let rental_token = &mut ctx.accounts.rental_token;
        rental_token.session = session.key();
        rental_token.renter = ctx.accounts.renter.key();
        rental_token.item = item.key();
        rental_token.minted_at = clock.unix_timestamp;
        rental_token.burned_at = 0;
        rental_token.status = RENTAL_TOKEN_STATUS_ACTIVE;
        rental_token.bump = ctx.bumps.rental_token;

        item.status = ITEM_STATUS_RENTED;
        item.active_session = session.key();

        emit!(RentalStarted {
            session: session.key(),
            item: item.key(),
            renter: session.renter,
            escrow_amount,
            expected_fee,
            due_ts: session.due_ts,
        });

        Ok(())
    }

    pub fn request_return(ctx: Context<RequestReturn>) -> Result<()> {
        require!(
            ctx.accounts.session.status == SESSION_STATUS_ACTIVE,
            RentProofError::SessionNotActive
        );
        require!(
            ctx.accounts.item.status == ITEM_STATUS_RENTED,
            RentProofError::ItemUnavailable
        );
        require!(
            ctx.accounts.session.return_requested_ts == 0,
            RentProofError::ReturnAlreadyRequested
        );

        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session;
        session.return_requested_ts = clock.unix_timestamp;

        emit!(ReturnRequested {
            session: session.key(),
            item: ctx.accounts.item.key(),
            renter: session.renter,
            requested_ts: session.return_requested_ts,
        });

        Ok(())
    }

    pub fn confirm_return(ctx: Context<SettleRental>) -> Result<()> {
        require!(
            ctx.accounts.session.status == SESSION_STATUS_ACTIVE,
            RentProofError::SessionNotActive
        );
        require!(
            ctx.accounts.item.status == ITEM_STATUS_RENTED,
            RentProofError::ItemUnavailable
        );

        let clock = Clock::get()?;
        let elapsed = settlement_elapsed_seconds(&ctx.accounts.session, clock.unix_timestamp)?;
        let final_fee = calculate_fee(&ctx.accounts.item, elapsed)?;
        let (platform_fee, owner_payout, renter_refund) = split_return_settlement(
            final_fee,
            ctx.accounts.session.escrow_amount,
            ctx.accounts.config.fee_bps,
        )?;

        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            owner_payout,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.platform_fee_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            platform_fee,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.renter_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            renter_refund,
        )?;
        close_escrow_account(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.renter.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
        )?;

        let session = &mut ctx.accounts.session;
        session.returned_ts = clock.unix_timestamp;
        session.final_fee = final_fee;
        session.owner_payout = owner_payout;
        session.platform_fee = platform_fee;
        session.renter_refund = renter_refund;
        session.status = SESSION_STATUS_RETURNED;

        let item = &mut ctx.accounts.item;
        item.status = ITEM_STATUS_AVAILABLE;
        item.active_session = Pubkey::default();

        let rental_token = &mut ctx.accounts.rental_token;
        rental_token.status = RENTAL_TOKEN_STATUS_BURNED;
        rental_token.burned_at = clock.unix_timestamp;

        emit!(RentalReturned {
            session: session.key(),
            item: item.key(),
            renter: session.renter,
            final_fee,
            owner_payout,
            platform_fee,
            renter_refund,
            rental_token_status: RENTAL_TOKEN_STATUS_BURNED,
        });

        Ok(())
    }

    pub fn auto_buyout(ctx: Context<AutoBuyout>) -> Result<()> {
        require!(
            ctx.accounts.session.status == SESSION_STATUS_ACTIVE,
            RentProofError::SessionNotActive
        );
        require!(
            ctx.accounts.item.status == ITEM_STATUS_RENTED,
            RentProofError::ItemUnavailable
        );

        let clock = Clock::get()?;
        let buyout_after = ctx
            .accounts
            .session
            .due_ts
            .checked_add(ctx.accounts.item.auto_buyout_grace_seconds)
            .ok_or(RentProofError::MathOverflow)?;
        require!(clock.unix_timestamp >= buyout_after, RentProofError::BuyoutNotReady);

        let final_fee = ctx.accounts.session.escrow_amount;
        let (platform_fee, owner_payout, renter_refund) =
            split_buyout_settlement(final_fee, ctx.accounts.config.fee_bps)?;

        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            owner_payout,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.platform_fee_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            platform_fee,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.renter_token_account.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
            renter_refund,
        )?;
        close_escrow_account(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.renter.to_account_info(),
            ctx.accounts.escrow_authority.to_account_info(),
            ctx.accounts.session.key(),
            ctx.accounts.session.escrow_bump,
        )?;

        let session = &mut ctx.accounts.session;
        session.returned_ts = 0;
        session.final_fee = final_fee;
        session.owner_payout = owner_payout;
        session.platform_fee = platform_fee;
        session.renter_refund = renter_refund;
        session.status = SESSION_STATUS_BUYOUT;

        let item = &mut ctx.accounts.item;
        item.status = ITEM_STATUS_BUYOUT;
        item.active_session = Pubkey::default();

        let rental_token = &mut ctx.accounts.rental_token;
        rental_token.status = RENTAL_TOKEN_STATUS_BURNED;
        rental_token.burned_at = clock.unix_timestamp;

        emit!(RentalBoughtOut {
            session: session.key(),
            item: item.key(),
            renter: session.renter,
            final_fee,
            owner_payout,
            platform_fee,
            rental_token_status: RENTAL_TOKEN_STATUS_BURNED,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub fee_authority: SystemAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + PlatformConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, PlatformConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: [u8; 32])]
pub struct InitializeItem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + RentalItem::INIT_SPACE,
        seeds = [b"item", owner.key().as_ref(), item_id.as_ref()],
        bump
    )]
    pub item: Box<Account<'info, RentalItem>>,
    pub payment_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(rental_id: [u8; 32])]
pub struct StartRental<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(
        mut,
        seeds = [b"item", item.owner.as_ref(), item.item_id.as_ref()],
        bump = item.bump,
        constraint = item.status == ITEM_STATUS_AVAILABLE @ RentProofError::ItemUnavailable,
        constraint = item.payment_mint == payment_mint.key() @ RentProofError::InvalidPaymentMint
    )]
    pub item: Account<'info, RentalItem>,
    #[account(mut)]
    pub renter: Signer<'info>,
    #[account(
        init,
        payer = renter,
        space = 8 + RentalSession::INIT_SPACE,
        seeds = [b"session", item.key().as_ref(), rental_id.as_ref()],
        bump
    )]
    pub session: Box<Account<'info, RentalSession>>,
    #[account(
        init,
        payer = renter,
        space = 8 + RentalToken::INIT_SPACE,
        seeds = [b"rental_token", session.key().as_ref()],
        bump
    )]
    pub rental_token: Box<Account<'info, RentalToken>>,
    #[account(
        init,
        payer = renter,
        token::mint = payment_mint,
        token::authority = escrow_authority,
        seeds = [b"escrow", session.key().as_ref()],
        bump
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA authority for the escrow token account.
    #[account(seeds = [b"escrow_authority", session.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = renter
    )]
    pub renter_token_account: Box<Account<'info, TokenAccount>>,
    pub payment_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RequestReturn<'info> {
    #[account(
        mut,
        seeds = [b"item", item.owner.as_ref(), item.item_id.as_ref()],
        bump = item.bump,
        constraint = item.status == ITEM_STATUS_RENTED @ RentProofError::ItemUnavailable,
        constraint = item.active_session == session.key() @ RentProofError::InvalidSession
    )]
    pub item: Box<Account<'info, RentalItem>>,
    #[account(mut)]
    pub renter: Signer<'info>,
    #[account(
        mut,
        constraint = session.item == item.key() @ RentProofError::InvalidSession,
        constraint = session.renter == renter.key() @ RentProofError::InvalidRenter,
        constraint = session.status == SESSION_STATUS_ACTIVE @ RentProofError::SessionNotActive,
        seeds = [b"session", item.key().as_ref(), session.rental_id.as_ref()],
        bump = session.bump
    )]
    pub session: Box<Account<'info, RentalSession>>,
    #[account(
        constraint = rental_token.session == session.key() @ RentProofError::InvalidRentalToken,
        constraint = rental_token.renter == renter.key() @ RentProofError::InvalidRenter,
        constraint = rental_token.status == RENTAL_TOKEN_STATUS_ACTIVE @ RentProofError::InvalidRentalToken,
        seeds = [b"rental_token", session.key().as_ref()],
        bump = rental_token.bump
    )]
    pub rental_token: Box<Account<'info, RentalToken>>,
}

#[derive(Accounts)]
pub struct SettleRental<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(
        mut,
        seeds = [b"item", item.owner.as_ref(), item.item_id.as_ref()],
        bump = item.bump,
        constraint = item.owner == owner.key() @ RentProofError::InvalidOwner,
        constraint = item.payment_mint == payment_mint.key() @ RentProofError::InvalidPaymentMint,
        constraint = item.active_session == session.key() @ RentProofError::InvalidSession
    )]
    pub item: Box<Account<'info, RentalItem>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, address = session.renter @ RentProofError::InvalidRenter)]
    pub renter: SystemAccount<'info>,
    #[account(address = config.fee_authority @ RentProofError::InvalidFeeAuthority)]
    pub fee_authority: SystemAccount<'info>,
    #[account(
        mut,
        constraint = session.item == item.key() @ RentProofError::InvalidSession,
        constraint = session.owner == owner.key() @ RentProofError::InvalidOwner,
        constraint = session.payment_mint == payment_mint.key() @ RentProofError::InvalidPaymentMint,
        seeds = [b"session", item.key().as_ref(), session.rental_id.as_ref()],
        bump = session.bump
    )]
    pub session: Box<Account<'info, RentalSession>>,
    #[account(
        mut,
        close = renter,
        constraint = rental_token.session == session.key() @ RentProofError::InvalidRentalToken,
        constraint = rental_token.renter == renter.key() @ RentProofError::InvalidRenter,
        seeds = [b"rental_token", session.key().as_ref()],
        bump = rental_token.bump
    )]
    pub rental_token: Box<Account<'info, RentalToken>>,
    #[account(
        mut,
        seeds = [b"escrow", session.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = escrow_authority
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA authority for the escrow token account.
    #[account(seeds = [b"escrow_authority", session.key().as_ref()], bump = session.escrow_bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = renter
    )]
    pub renter_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = owner
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = fee_authority
    )]
    pub platform_fee_token_account: Box<Account<'info, TokenAccount>>,
    pub payment_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AutoBuyout<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(
        mut,
        seeds = [b"item", item.owner.as_ref(), item.item_id.as_ref()],
        bump = item.bump,
        constraint = item.payment_mint == payment_mint.key() @ RentProofError::InvalidPaymentMint,
        constraint = item.active_session == session.key() @ RentProofError::InvalidSession
    )]
    pub item: Box<Account<'info, RentalItem>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, address = item.owner @ RentProofError::InvalidOwner)]
    pub owner: SystemAccount<'info>,
    #[account(mut, address = session.renter @ RentProofError::InvalidRenter)]
    pub renter: SystemAccount<'info>,
    #[account(address = config.fee_authority @ RentProofError::InvalidFeeAuthority)]
    pub fee_authority: SystemAccount<'info>,
    #[account(
        mut,
        constraint = session.item == item.key() @ RentProofError::InvalidSession,
        constraint = session.owner == owner.key() @ RentProofError::InvalidOwner,
        constraint = session.payment_mint == payment_mint.key() @ RentProofError::InvalidPaymentMint,
        seeds = [b"session", item.key().as_ref(), session.rental_id.as_ref()],
        bump = session.bump
    )]
    pub session: Box<Account<'info, RentalSession>>,
    #[account(
        mut,
        close = renter,
        constraint = rental_token.session == session.key() @ RentProofError::InvalidRentalToken,
        constraint = rental_token.renter == renter.key() @ RentProofError::InvalidRenter,
        seeds = [b"rental_token", session.key().as_ref()],
        bump = rental_token.bump
    )]
    pub rental_token: Box<Account<'info, RentalToken>>,
    #[account(
        mut,
        seeds = [b"escrow", session.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = escrow_authority
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA authority for the escrow token account.
    #[account(seeds = [b"escrow_authority", session.key().as_ref()], bump = session.escrow_bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = renter
    )]
    pub renter_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = owner
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = fee_authority
    )]
    pub platform_fee_token_account: Box<Account<'info, TokenAccount>>,
    pub payment_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub authority: Pubkey,
    pub fee_authority: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RentalItem {
    pub owner: Pubkey,
    pub payment_mint: Pubkey,
    pub item_id: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub rate_per_second: u64,
    pub minimum_fee: u64,
    pub buyout_cap: u64,
    pub auto_buyout_grace_seconds: i64,
    pub active_session: Pubkey,
    pub status: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RentalSession {
    pub item: Pubkey,
    pub renter: Pubkey,
    pub owner: Pubkey,
    pub payment_mint: Pubkey,
    pub rental_id: [u8; 32],
    pub start_ts: i64,
    pub due_ts: i64,
    pub returned_ts: i64,
    pub escrow_amount: u64,
    pub expected_fee_at_start: u64,
    pub final_fee: u64,
    pub owner_payout: u64,
    pub platform_fee: u64,
    pub renter_refund: u64,
    pub return_requested_ts: i64,
    pub status: u8,
    pub bump: u8,
    pub escrow_bump: u8,
    pub rental_token_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RentalToken {
    pub session: Pubkey,
    pub renter: Pubkey,
    pub item: Pubkey,
    pub minted_at: i64,
    pub burned_at: i64,
    pub status: u8,
    pub bump: u8,
}

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub fee_authority: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct ItemInitialized {
    pub item: Pubkey,
    pub owner: Pubkey,
    pub payment_mint: Pubkey,
    pub buyout_cap: u64,
}

#[event]
pub struct RentalStarted {
    pub session: Pubkey,
    pub item: Pubkey,
    pub renter: Pubkey,
    pub escrow_amount: u64,
    pub expected_fee: u64,
    pub due_ts: i64,
}

#[event]
pub struct ReturnRequested {
    pub session: Pubkey,
    pub item: Pubkey,
    pub renter: Pubkey,
    pub requested_ts: i64,
}

#[event]
pub struct RentalReturned {
    pub session: Pubkey,
    pub item: Pubkey,
    pub renter: Pubkey,
    pub final_fee: u64,
    pub owner_payout: u64,
    pub platform_fee: u64,
    pub renter_refund: u64,
    pub rental_token_status: u8,
}

#[event]
pub struct RentalBoughtOut {
    pub session: Pubkey,
    pub item: Pubkey,
    pub renter: Pubkey,
    pub final_fee: u64,
    pub owner_payout: u64,
    pub platform_fee: u64,
    pub rental_token_status: u8,
}

#[error_code]
pub enum RentProofError {
    #[msg("Platform fee is above the allowed maximum")]
    FeeTooHigh,
    #[msg("Invalid pricing parameters")]
    InvalidPricing,
    #[msg("Invalid rental window")]
    InvalidRentalWindow,
    #[msg("Item is not available")]
    ItemUnavailable,
    #[msg("Session is not active")]
    SessionNotActive,
    #[msg("Auto-buyout is not ready yet")]
    BuyoutNotReady,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid owner")]
    InvalidOwner,
    #[msg("Invalid renter")]
    InvalidRenter,
    #[msg("Invalid platform fee authority")]
    InvalidFeeAuthority,
    #[msg("Invalid payment mint")]
    InvalidPaymentMint,
    #[msg("Invalid rental session")]
    InvalidSession,
    #[msg("Invalid rental token")]
    InvalidRentalToken,
    #[msg("Invalid platform authority")]
    InvalidPlatformAuthority,
    #[msg("Return has already been requested")]
    ReturnAlreadyRequested,
}

fn calculate_fee(item: &RentalItem, elapsed_seconds: i64) -> Result<u64> {
    let billable_seconds = elapsed_seconds.max(1) as u64;
    let metered_fee = item
        .rate_per_second
        .checked_mul(billable_seconds)
        .ok_or(RentProofError::MathOverflow)?;
    Ok(metered_fee.max(item.minimum_fee).min(item.buyout_cap))
}

fn split_return_settlement(
    final_fee: u64,
    escrow_amount: u64,
    fee_bps: u16,
) -> Result<(u64, u64, u64)> {
    require!(final_fee <= escrow_amount, RentProofError::MathOverflow);
    let platform_fee = final_fee
        .checked_mul(fee_bps as u64)
        .ok_or(RentProofError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(RentProofError::MathOverflow)?;
    let owner_payout = final_fee
        .checked_sub(platform_fee)
        .ok_or(RentProofError::MathOverflow)?;
    let renter_refund = escrow_amount
        .checked_sub(final_fee)
        .ok_or(RentProofError::MathOverflow)?;
    Ok((platform_fee, owner_payout, renter_refund))
}

fn settlement_elapsed_seconds(session: &RentalSession, now_ts: i64) -> Result<i64> {
    let requested_or_now = if session.return_requested_ts > 0 {
        session.return_requested_ts
    } else {
        now_ts
    };
    let fee_cutoff_ts = requested_or_now.min(session.due_ts);
    Ok(fee_cutoff_ts
        .checked_sub(session.start_ts)
        .ok_or(RentProofError::MathOverflow)?
        .max(1))
}

fn split_buyout_settlement(final_fee: u64, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let platform_fee = final_fee
        .checked_mul(fee_bps as u64)
        .ok_or(RentProofError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(RentProofError::MathOverflow)?;
    let owner_payout = final_fee
        .checked_sub(platform_fee)
        .ok_or(RentProofError::MathOverflow)?;
    Ok((platform_fee, owner_payout, 0))
}

fn transfer_from_escrow<'info>(
    token_program: AccountInfo<'info>,
    escrow_token_account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    escrow_authority: AccountInfo<'info>,
    session_key: Pubkey,
    escrow_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let signer_seeds: &[&[u8]] = &[
        b"escrow_authority",
        session_key.as_ref(),
        &[escrow_bump],
    ];
    let signer = &[signer_seeds];

    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer {
                from: escrow_token_account,
                to: destination,
                authority: escrow_authority,
            },
            signer,
        ),
        amount,
    )
}

fn close_escrow_account<'info>(
    token_program: AccountInfo<'info>,
    escrow_token_account: AccountInfo<'info>,
    renter: AccountInfo<'info>,
    escrow_authority: AccountInfo<'info>,
    session_key: Pubkey,
    escrow_bump: u8,
) -> Result<()> {
    let signer_seeds: &[&[u8]] = &[
        b"escrow_authority",
        session_key.as_ref(),
        &[escrow_bump],
    ];
    let signer = &[signer_seeds];

    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: escrow_token_account,
            destination: renter,
            authority: escrow_authority,
        },
        signer,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_item() -> RentalItem {
        RentalItem {
            owner: Pubkey::default(),
            payment_mint: Pubkey::default(),
            item_id: [1; 32],
            metadata_hash: [2; 32],
            rate_per_second: 2,
            minimum_fee: 10,
            buyout_cap: 100,
            auto_buyout_grace_seconds: 60,
            active_session: Pubkey::default(),
            status: ITEM_STATUS_AVAILABLE,
            bump: 255,
        }
    }

    fn test_session() -> RentalSession {
        RentalSession {
            item: Pubkey::default(),
            renter: Pubkey::default(),
            owner: Pubkey::default(),
            payment_mint: Pubkey::default(),
            rental_id: [3; 32],
            start_ts: 1_000,
            due_ts: 4_600,
            returned_ts: 0,
            escrow_amount: 100,
            expected_fee_at_start: 10,
            final_fee: 0,
            owner_payout: 0,
            platform_fee: 0,
            renter_refund: 0,
            return_requested_ts: 0,
            status: SESSION_STATUS_ACTIVE,
            bump: 255,
            escrow_bump: 254,
            rental_token_bump: 253,
        }
    }

    #[test]
    fn metered_fee_respects_minimum_and_cap() {
        let item = test_item();
        assert_eq!(calculate_fee(&item, 1).unwrap(), 10);
        assert_eq!(calculate_fee(&item, 20).unwrap(), 40);
        assert_eq!(calculate_fee(&item, 80).unwrap(), 100);
    }

    #[test]
    fn return_settlement_splits_fee_and_refund() {
        let (platform_fee, owner_payout, renter_refund) =
            split_return_settlement(40, 100, 500).unwrap();
        assert_eq!(platform_fee, 2);
        assert_eq!(owner_payout, 38);
        assert_eq!(renter_refund, 60);
    }

    #[test]
    fn buyout_settlement_leaves_no_refund() {
        let (platform_fee, owner_payout, renter_refund) =
            split_buyout_settlement(100, 500).unwrap();
        assert_eq!(platform_fee, 5);
        assert_eq!(owner_payout, 95);
        assert_eq!(renter_refund, 0);
    }

    #[test]
    fn settlement_elapsed_uses_return_request_when_present() {
        let mut session = test_session();
        session.return_requested_ts = 1_900;
        assert_eq!(settlement_elapsed_seconds(&session, 4_000).unwrap(), 900);
    }

    #[test]
    fn settlement_elapsed_is_capped_at_due_time() {
        let session = test_session();
        assert_eq!(settlement_elapsed_seconds(&session, 9_000).unwrap(), 3_600);
    }
}
