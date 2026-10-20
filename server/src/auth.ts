// Auth hooks. Contract: docs/protocol/core.md#3-auth

// The client flattens its whole login request into session vars, incl. the plaintext password.
// Keep only the small, useful ones (they end up inside the session JWT).
const AUTH_KEPT_VARS = ["deviceOS", "deviceType", "operatingSystem", "scriptData"];

function authStripVars(account: { vars?: { [key: string]: string } } | undefined) {
    if (!account || !account.vars) return;
    const kept: { [key: string]: string } = {};
    for (const key of AUTH_KEPT_VARS) {
        if (account.vars[key] !== undefined) kept[key] = account.vars[key];
    }
    account.vars = kept;
}

function beforeAuthenticateEmail(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, data: nkruntime.AuthenticateEmailRequest) {
    authStripVars(data.account);
    return data;
}

function beforeAuthenticateDevice(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, data: nkruntime.AuthenticateDeviceRequest) {
    authStripVars(data.account);
    return data;
}

// Token re-login: client later calls AuthenticateCustom(sha256hex(token), create:false).
function authLinkSessionToken(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, token: string) {
    const customId = nk.sha256Hash(token).toLowerCase();
    try {
        const account = nk.accountGetId(userId);
        if (account.customId) nk.unlinkCustom(userId, account.customId);
        nk.linkCustom(userId, customId);
    } catch (e) {
        logger.error("authLinkSessionToken %s: %s", userId, String(e));
    }
}

function afterAuthenticateEmail(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, data: nkruntime.Session, request: nkruntime.AuthenticateEmailRequest) {
    authLinkSessionToken(nk, logger, ctx.userId || "", data.token || "");
    // Registration (create=true made a new account): starts unverified, see accVerifyStart (account.ts).
    if (data.created && ctx.userId) {
        try { accVerifyStart(ctx, nk, ctx.userId); } catch (e) { logger.error("accVerifyStart %s: %s", ctx.userId, String(e)); }
    }
}

function afterAuthenticateDevice(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, data: nkruntime.Session, request: nkruntime.AuthenticateDeviceRequest) {
    authLinkSessionToken(nk, logger, ctx.userId || "", data.token || "");
}
