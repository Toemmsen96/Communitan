// GameSparks-compatible envelope helpers. Contract: docs/protocol/core.md

interface GsRequest {
    "@class": string;
    requestId?: string;
    eventKey?: string;
    [key: string]: any;
}

interface GsContext {
    ctx: nkruntime.Context;
    logger: nkruntime.Logger;
    nk: nkruntime.Nakama;
    id: string;
    req: GsRequest;
    userId: string;
}

// Returns scriptData for the response, or a full response object via gsRaw().
type GsHandler = (c: GsContext) => any;
type GsHandlerTable = { [id: string]: GsHandler };

class GsError {
    constructor(public error: any) {}
}

class GsRaw {
    constructor(public body: { [key: string]: any }) {}
}

function gsRaw(body: { [key: string]: any }): GsRaw {
    return new GsRaw(body);
}

// Throw from a handler to answer with {error: ...}.
function gsFail(error: any): never {
    throw new GsError(typeof error === "string" ? { code: error } : error);
}

// ".LogEventRequest" -> ".LogEventResponse", ".AccountDetailsRequest" -> ".AccountDetailsResponse"
function gsResponseClass(req: GsRequest): string {
    const cls = req["@class"] || ".LogEventRequest";
    return cls.replace(/Request$/, "Response");
}

function gsResponse(req: GsRequest, result: any): string {
    let body: { [key: string]: any };
    if (result instanceof GsRaw) {
        body = result.body;
    } else {
        body = {};
        if (result !== undefined && result !== null) body.scriptData = result;
    }
    if (body["@class"] === undefined) body["@class"] = gsResponseClass(req);
    if (body.requestId === undefined && req.requestId !== undefined) body.requestId = req.requestId;
    if (body.eventKey === undefined && req.eventKey !== undefined) body.eventKey = req.eventKey; // PROD echoes eventKey on LogEvent responses
    return JSON.stringify(body);
}

function gsErrorResponse(req: GsRequest, error: any): string {
    return JSON.stringify({ "@class": gsResponseClass(req), requestId: req.requestId, error: error });
}

// Server push: Nakama notification whose content is a GS message. Contract: docs/protocol/core.md#notifications
function gsPush(nk: nkruntime.Nakama, userId: string, message: { [key: string]: any }, persistent = true) {
    const cls: string = message["@class"] || ".ScriptMessage";
    const subject: string = message.extCode || cls.substring(1);
    nk.notificationSend(userId, subject, message, 1, STORE_SYSTEM_USER, persistent);
}

function gsPushScript(nk: nkruntime.Nakama, userId: string, extCode: string, data: any, persistent = true) {
    gsPush(nk, userId, { "@class": ".ScriptMessage", extCode: extCode, data: data, messageId: nk.uuidv4() }, persistent);
}
