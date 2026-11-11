// @ts-check
// Standard Lambda HTTP response builder
function http(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  }
}

// Standard envelope: { ok: true, data } or { ok: false, error: CODE, message }
const success = (data, statusCode = 200)         => http(statusCode, { ok: true,  data })
const fail    = (statusCode, errorCode, message) => http(statusCode, { ok: false, error: errorCode, message })

const badReq    = (msg, code = 'BAD_REQUEST')     => fail(400, code, msg)
const unauth    = (msg = 'Unauthorized')          => fail(401, 'UNAUTHORIZED',  msg)
const forbidden = (msg = 'Forbidden')             => fail(403, 'FORBIDDEN',     msg)
const missing   = (msg = 'Not found')             => fail(404, 'NOT_FOUND',     msg)
const internal  = (msg = 'Internal server error') => fail(500, 'SERVER_ERROR',  msg)

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
    },
    body: JSON.stringify(body)
  }
}

module.exports = { success, fail, badReq, unauth, forbidden, missing, internal, respond }
