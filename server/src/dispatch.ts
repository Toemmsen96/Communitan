// Single RPC entry point for every GS request id. Handlers live in per-domain tables.

let GS_HANDLERS: GsHandlerTable = {};
let GS_READY = false;

// Nakama runs InitModule in ONE VM but RPCs in pooled VMs: each VM must build its own table on first use.
function gsInit() {
    if (GS_READY) return;
    for (const table of gsTables()) {
        for (const id in table) GS_HANDLERS[id] = table[id];
    }
    GS_READY = true;
}
// Ids that may be called without a user session (http_key). Nothing else calls RPCs server-to-server.
const GS_PUBLIC_IDS: { [id: string]: boolean } = { COMMUNITAN_STATUS: true };
let GS_UNKNOWN_SEEN: { [id: string]: boolean } = {};

function rpcDispatch(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    gsInit();
    let req: GsRequest;
    try {
        req = payload ? JSON.parse(payload) : { "@class": ".LogEventRequest" };
    } catch (e) {
        logger.error("rpcDispatch: bad payload: %s", payload);
        return JSON.stringify({ error: { code: "BAD_JSON" } });
    }
    const cls = (req["@class"] || "").replace(/^\./, "");
    const id = req.eventKey || cls;
    // runtime.http_key is a PUBLIC status key (docs/HOSTING.md): calls without a session only reach the allowlist.
    if (!ctx.userId && !GS_PUBLIC_IDS[id]) {
        return gsErrorResponse(req, { code: "UNAUTHORIZED" });
    }
    stTouchOnline(nk, logger, ctx.userId || "");
    const handler = GS_HANDLERS[id];
    if (!handler) {
        if (!GS_UNKNOWN_SEEN[id]) {
            GS_UNKNOWN_SEEN[id] = true;
            logger.warn("UNHANDLED rpc id=%s payload=%s", id, payload);
        }
        return gsResponse(req, {});
    }
    try {
        const result = handler({ ctx: ctx, logger: logger, nk: nk, id: id, req: req, userId: ctx.userId || "" });
        return gsResponse(req, result);
    } catch (e) {
        if (e instanceof GsError) return gsErrorResponse(req, e.error);
        logger.error("rpc %s failed: %s", id, String(e));
        return gsErrorResponse(req, { code: "SERVER_ERROR" });
    }
}
