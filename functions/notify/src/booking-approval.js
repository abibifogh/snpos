/**
 * Telling a party's ANSWER apart from a party's request.
 *
 * Both land in booking_changes, because a guest cannot write to a booking row
 * and should not be able to: a link that could edit a booking is a link that
 * could empty a pass. So when the house revises a booking and sends it to be
 * agreed to, the agreement comes back as a message, and this job — which holds
 * a server key — is what stamps the booking from it.
 *
 * A DELIBERATE COPY of the constant in packages/core/src/booking-approval.ts.
 * A function is deployed on its own and cannot import the workspace, and the
 * two sides of this must agree exactly: if the page writes one word and the job
 * looks for another, every approval a party sends is silently filed as an
 * ordinary change request and nobody is ever told they agreed. A test holds
 * them together — see the core tests.
 */

/** The kind written on a change request that is the party agreeing. */
export const APPROVAL_KIND = 'approved';

/** Whether this change request is a party's approval rather than a request. */
export const isApproval = (c) => c?.kind === APPROVAL_KIND;
