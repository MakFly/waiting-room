import { SignJWT, jwtVerify } from "jose"
import { env } from "./config.ts"

const secret = new TextEncoder().encode(env.WR_JWT_SECRET)

/**
 * A ticket proves a client's place in a queue. It is opaque to the client and
 * signed, so position cannot be forged. It has no expiry: losing it (clearing
 * cookies) means losing your place — which is the intended trade-off.
 */
export type TicketClaims = {
  kind: "ticket"
  dropId: string
  ticketId: string
  seq: number
}

/**
 * A pass is the admission credential the real site checks. Short-lived: once it
 * expires the holder is bounced back to the queue.
 */
export type PassClaims = {
  kind: "pass"
  dropId: string
  ticketId: string
}

export async function signTicket(c: TicketClaims): Promise<string> {
  return new SignJWT(c)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(secret)
}

export async function verifyTicket(token: string): Promise<TicketClaims> {
  const { payload } = await jwtVerify(token, secret)
  if (payload.kind !== "ticket") throw new Error("not a ticket")
  return payload as unknown as TicketClaims
}

export async function signPass(c: PassClaims, ttlSec: number): Promise<string> {
  return new SignJWT(c)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(secret)
}

export async function verifyPass(token: string): Promise<PassClaims> {
  // jwtVerify rejects expired passes for us.
  const { payload } = await jwtVerify(token, secret)
  if (payload.kind !== "pass") throw new Error("not a pass")
  return payload as unknown as PassClaims
}
