/**
 * Shared identity of the detection/scoring pipeline. Setup state rows in
 * `market_state` are keyed by this version, so any change to detection or
 * scoring semantics must bump it — old rows then age out naturally (24h TTL)
 * instead of being silently reinterpreted by the new logic.
 *
 * Consumed by the scanner (setup keys) and the dashboard tracker (filtering),
 * so it lives in a dependency-free module that is safe on both server and client.
 */
export const ENGINE_VERSION = "tori-v4";
