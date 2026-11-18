// The questions the keeper buys, and every check that can be done before paying for one.
//
// bodies/ holds each oracle.request body with its question and definitions FROZEN: the leaves pin them on chain (SwarmQuestions) and one
// changed character makes a leaf refuse the answer after it is paid for. Only what is not in the hashed document changes per purchase:
// consumer, panelSize, quorum, guards.
//
// CONSUMER. An attestation binds to one leaf through the EIP-712 domain, so v1 and v2 answers are bought separately. It must be lowercase:
// the plane answers a checksummed address with a bare 400.
// QUORUM. The request's quorum must be the leaf's own floor: live attestations show `agreed` at or above it (66-74 at quorum 67),
// but the deployer can settle a split BELOW the quorum (request 54127d2e, 66 of 67): the leaf refuses that one, ~1 in 190 paid.
import { readFileSync } from "node:fs";
import { BigNumber, utils } from "ethers";
import { canon } from "./x402.mjs";

const BODIES = { price: "price", spot: "spot", nhi: "nhi", seatMedian: "seat-median", seatSpot: "seat-spot" };
const PROBE_FROM = 26_000_000, PROBE_TO = 26_000_600;

export const bodyOf = (role) => JSON.parse(readFileSync(new URL(`../bodies/${BODIES[role]}.json`, import.meta.url), "utf8"));

/** The document the plane hashes: the same keys it hashes (questionDocument), RFC 8785 subset. */
export function questionDoc(body, window) {
  return {
    v: body.v,
    question: body.question,
    chainId: body.chainId,
    window,
    answerType: body.answerType,
    ...(body.head !== undefined ? { head: body.head } : {}),
    ...(body.definitions ? { definitions: body.definitions } : {}),
    ...(body.evidence === "panel" ? { evidence: "panel" } : {}),
  };
}
export const questionHash = (body, fromBlock, toBlock) => utils.keccak256(utils.toUtf8Bytes(canon(questionDoc(body, { fromBlock, toBlock }))));

/** Refuses anything a paid answer could not clear. Returns the problems; pay only on an empty list. Read from the leaf, never assumed. */
export async function leafProblems(leaf, role, body = bodyOf(role)) {
  const out = [];
  const [expected, chainId, answerType] = await Promise.all([leaf.expectedQuestionHash(PROBE_FROM, PROBE_TO), leaf.attestationChainId(), leaf.attestationAnswerType()]);
  const ours = questionHash(body, PROBE_FROM, PROBE_TO);
  if (expected !== ours) out.push(`${role}: the leaf pins question ${expected}, the payload asks ${ours}: every answer would be refused`);
  if (Number(chainId) !== Number(body.chainId)) out.push(`${role}: the leaf reads chain ${chainId}, the payload asks about ${body.chainId}`);
  if (Number(answerType) !== 3 || body.answerType !== "uint256") out.push(`${role}: the leaf takes answer type ${answerType}, the payload ${body.answerType}`);
  return out;
}

/** The body to send: frozen question, this leaf as consumer, the panel its floors need, guards for this purchase (never in the hash).
 *  `consumerChainId`: the chain the LEAF lives on (the EIP-712 domain the attestation is signed under): 1 on mainnet, 4663 for a 4663
 *  leaf. The question's own `chainId` (the chain it reads, always Ethereum for IMD) is in the frozen body and never changes. */
export async function buildInput(leaf, role, { guards, consumerChainId = 1 } = {}) {
  const body = bodyOf(role);
  const [panel, agreed] = await Promise.all([leaf.MIN_PANEL_SIZE(), leaf.minAgreed()]);
  const out = { ...body, panelSize: Number(panel), quorum: Number(agreed), consumer: { chainId: Number(consumerChainId), verifyingContract: leaf.address.toLowerCase() } };
  if (guards) out.guards = guards;
  return out;
}

/** Guards pinned to this purchase: the leaf's band now, widened to hold what we expect the answer to be. */
export function guardsFor(anchor, allowanceBps, estimates, marginBps = 200) {
  const a = BigNumber.from(anchor);
  let lo = a.mul(10_000 - allowanceBps > 0 ? 10_000 - allowanceBps : 0).div(10_000);
  let hi = a.mul(10_000 + allowanceBps).div(10_000);
  for (const e of estimates) {
    const low = BigNumber.from(e).mul(10_000 - marginBps).div(10_000), high = BigNumber.from(e).mul(10_000 + marginBps).div(10_000);
    if (low.lt(lo)) lo = low;
    if (high.gt(hi)) hi = high;
  }
  return { min: lo.toString(), max: hi.toString() };
}

/** How many capped steps it takes to walk `from` to `to`. */
export function stepsNeeded(from, to, capBps) {
  const f = BigNumber.from(from), t = BigNumber.from(to);
  if (f.isZero()) return 1;
  const ratio = Number(utils.formatUnits(t.mul(1e9).div(f), 9));
  if (ratio <= 0) return Infinity;
  return Math.max(1, Math.ceil(Math.abs(Math.log(ratio)) / Math.log(1 + capBps / 10_000)));
}

/** The signed fields as the leaf's tuple. */
export function toTuple(m) {
  const answerType = typeof m.answerType === "string" ? { bool: 0, address: 1, bytes32: 2, uint256: 3 }[m.answerType] : Number(m.answerType);
  return [m.requestId, BigNumber.from(m.chainId), m.questionHash, answerType, m.answer, BigNumber.from(m.figure), m.fromBlock, m.toBlock, m.blockHash, m.panelJobId, m.panelSize, m.quorum, m.agreed, m.issuedAt, m.expiresAt];
}

/**
 * Every guard SwarmFeed.submitAttestation applies, read from the leaf (as the v1 keeper does, on the v2 rules: permissionless
 * relay, leaf.accepts rather than a re-derived band). Returns { fail: string[], consumed, terminal, tuple, signature, message }.
 */
export async function preflightAttestation(provider, leaf, attestation, { evmHead = null } = {}) {
  const { domain, message: m, signature, signer } = attestation;
  const [attester, chainId, wantType, maxAge, used, sep, minPanel, minAgreed, cur, last, expected] = await Promise.all([
    leaf.attester(), leaf.attestationChainId(), leaf.attestationAnswerType(), leaf.maxAge(), leaf.usedRequests(m.requestId), leaf.DOMAIN_SEPARATOR(),
    leaf.MIN_PANEL_SIZE(), leaf.minAgreed(), leaf.latestValue(), leaf.lastToBlock(), leaf.expectedQuestionHash(m.fromBlock, m.toBlock),
  ]);
  const block = await provider.getBlock("latest");
  // The window is checked against the block number the LEAF sees: on 4663 (Arbitrum) block.number is Ethereum's (`evmHead`, lib/chains.mjs).
  const head = { timestamp: block.timestamp, number: evmHead ? await evmHead() : block.number };
  const now = head.timestamp;
  const fail = [];
  let terminal = false;
  const answerType = typeof m.answerType === "string" ? { bool: 0, address: 1, bytes32: 2, uint256: 3 }[m.answerType] : Number(m.answerType);
  if (used) return { fail: ["requestId already consumed"], consumed: true, terminal: true };
  const never = (s) => { fail.push(s); terminal = true; };
  if (String(signer).toLowerCase() !== attester.toLowerCase()) never(`signer ${signer} is not the attester ${attester}`);
  if (!BigNumber.from(m.chainId).eq(chainId)) never(`data chain ${m.chainId}, the leaf reads ${chainId}`);
  if (answerType !== Number(wantType)) never(`answer type ${answerType}, the leaf takes ${wantType}`);
  if (now > Number(m.expiresAt)) never(`expired ${now - Number(m.expiresAt)}s ago`);
  if (now - Number(m.issuedAt) > Number(maxAge)) never("issued longer ago than the leaf's life");
  if (Number(cur.updatedAt) > 0 && Number(m.issuedAt) < Number(cur.updatedAt)) never("older than the stored value");
  const answer = typeof m.answer === "string" && m.answer.length === 66 ? BigNumber.from(m.answer) : null;
  if (!answer) never("the answer is not one 32-byte word");
  else if (answer.isZero()) never("the answer is zero");
  if (Number(m.panelSize) < Number(minPanel)) never(`panel ${m.panelSize} under the floor ${minPanel}`);
  if (Number(m.agreed) < Number(minAgreed) || Number(m.agreed) > Number(m.panelSize)) never(`agreed ${m.agreed} under the floor ${minAgreed}`);
  if (expected.toLowerCase() !== String(m.questionHash).toLowerCase()) never(`question ${m.questionHash}, the leaf expects ${expected}`);
  if (Number(m.toBlock) <= Number(last)) never(`window ${m.toBlock} does not advance past ${last}`);
  if (Number(m.toBlock) > head.number) fail.push(`window ends at ${m.toBlock}, after the head ${head.number}`);
  else if (head.number - Number(m.toBlock) > Math.floor(Number(maxAge) / 12)) never(`window ended ${head.number - Number(m.toBlock)} blocks ago, past the leaf's life`);
  if (utils._TypedDataEncoder.hashDomain(domain) !== sep) never(`signed under domain ${utils._TypedDataEncoder.hashDomain(domain)}, the leaf is ${sep}: was consumer set?`);
  if (answer && !answer.isZero() && !(await leaf.accepts(answer))) fail.push(`${answer} is past what the leaf accepts now`);
  return { fail, consumed: false, terminal, tuple: toTuple(m), signature, message: m, value: answer };
}
