import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { motion } from "framer-motion";

// --- Config ---
const ES_URL = "https://index.multiversx.com/events/_search"; // POST
const GOVERNANCE_SC = "erd1qqqqqqqqqqqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrlllsrujgla";

const DELEGATION_LABELS: Record<string, string> = {
  "erd1qqqqqqqqqqqqqpgqxwakt2g7u9atsnr03gqcgmhcv38pt7mkd94q6shuwt": "Legacy Delegation",
  "erd1qqqqqqqqqqqqqpgq6uzdzy54wnesfnlaycxwymrn9texlnmyah0ssrfvk6": "xoxno",
  "erd1qqqqqqqqqqqqqpgq4gzfcw7kmkjy8zsf04ce6dl0auhtzjx078sslvrf4e": "hatom",
};

// --- Utilities ---
const hexToAscii = (hex?: string) => {
  if (!hex) return "";
  try {
    const bytes = hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
    return String.fromCharCode(...bytes).replace(/\u0000+$/g, "");
  } catch {
    return "";
  }
};

const hexToBigInt = (hex?: string) => {
  if (!hex) return 0n;
  // allow odd-length
  const h = hex.length % 2 === 1 ? "0" + hex : hex;
  try {
    return BigInt("0x" + h);
  } catch {
    return 0n;
  }
};

// bech32 encoding for MultiversX (hrp "erd"). Minimal implementation.
// Based on BIP-0173 – pure TS, no deps.
const bech32Polymod = (values: number[]) => {
  const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if (((b >> i) & 1) !== 0) chk ^= GENERATORS[i];
    }
  }
  return chk;
};

const bech32HrpExpand = (hrp: string) => {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
};

const bech32CreateChecksum = (hrp: string, data: number[]) => {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const rv = [] as number[];
  for (let p = 0; p < 6; p++) rv.push((mod >> (5 * (5 - p))) & 31);
  return rv;
};

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const bech32Encode = (hrp: string, data: number[]) => {
  const combined = data.concat(bech32CreateChecksum(hrp, data));
  let out = hrp + "1";
  for (const d of combined) out += BECH32_ALPHABET[d];
  return out;
};

// convert 8-bit bytes to 5-bit groups
const convertBits = (data: number[], from: number, to: number, pad = true) => {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) ret.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return ret;
};

const hexToBech32Erd = (hex32?: string) => {
  if (!hex32) return undefined;
  try {
    const bytes = hex32.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
    if (bytes.length !== 32) return undefined;
    const five = convertBits(bytes, 8, 5, true) as number[];
    return bech32Encode("erd", five);
  } catch {
    return undefined;
  }
};

// Format bigints as eGLD (assume 18 decimals)
const EGLD_DEC = 18n;
const formatEgld = (amount: bigint) => {
  const neg = amount < 0n;
  let a = neg ? -amount : amount;
  const int = a / 10n ** EGLD_DEC;
  const frac = a % 10n ** EGLD_DEC;
  const fracStr = frac.toString().padStart(Number(EGLD_DEC), "0").slice(0, 4); // 4 dp
  return `${neg ? "-" : ""}${int.toString()}.${fracStr} EGLD`;
};

// Voting option decoding
const decodeOption = (hex?: string): "yes" | "no" | "abstain" | "veto" | "unknown" => {
  const s = hexToAscii(hex).toLowerCase();
  if (s === "yes") return "yes";
  if (s === "no") return "no";
  if (s === "abstain") return "abstain";
  if (s === "veto" || s === "ncv" || s === "veto_power") return "veto";
  return "unknown";
};

// --- Types ---
interface EsHit {
  _source: {
    logAddress?: string;
    identifier: string; // "vote" | "delegateVote" | etc
    address?: string; // the caller (delegation contract)
    topics: string[]; // hex strings
    timestamp?: number;
    timestampMs?: number;
    txHash?: string;
  };
}

interface VoteAgg {
  option: string;
  count: number;
  power: bigint; // summed voting power
}

// --- Fetching from Elasticsearch ---
const buildQuery = (from = 0, size = 10000) => ({
  from,
  size,
  sort: [{ timestamp: { order: "asc" } }],
  query: {
    bool: {
      must: [
        {
          bool: {
            should: [
              { term: { address: GOVERNANCE_SC } },
              { term: { logAddress: GOVERNANCE_SC } },
            ],
          },
        },
        { terms: { identifier: ["vote", "delegateVote"] } },
      ],
    },
  },
});

// --- Component ---
export default function GovernanceDashboard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawHits, setRawHits] = useState<EsHit[]>([]);
  const [limit, setLimit] = useState(10000);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(ES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildQuery(0, limit)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRawHits((data?.hits?.hits ?? []) as EsHit[]);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Aggregations ---
  const stats = useMemo(() => {
    const byOption: Record<string, VoteAgg> = {
      yes: { option: "yes", count: 0, power: 0n },
      no: { option: "no", count: 0, power: 0n },
      abstain: { option: "abstain", count: 0, power: 0n },
      veto: { option: "veto", count: 0, power: 0n },
      unknown: { option: "unknown", count: 0, power: 0n },
    };

    const perCategoryAddresses: Record<
      "yes" | "no" | "abstain" | "veto" | "unknown",
      Map<string, { stake: bigint; power: bigint; count: number }>
    > = {
      yes: new Map(),
      no: new Map(),
      abstain: new Map(),
      veto: new Map(),
      unknown: new Map(),
    };

    let totalPower = 0n;

    // Delegation source breakdown
    const delegationBreakdown = new Map<string, bigint>();

    for (const hit of rawHits) {
      const s = hit._source;
      const id = s.identifier;
      const t = s.topics || [];
      if (!t.length) continue;

      if (id === "vote") {
        // Topics: [proposal, option, totalStake, totalVotingPower]
        const option = decodeOption(t[1]);
        const votePower = hexToBigInt(t[3]);
        byOption[option].count += 1;
        byOption[option].power += votePower;
        totalPower += votePower;
        // no per-address granularity for aggregate vote
      } else if (id === "delegateVote") {
        // Topics: [proposal, option, voter(32 bytes), userStake, votePower]
        const option = decodeOption(t[1]);
        const voterHex = t[2];
        const voterAddr = hexToBech32Erd(voterHex) ?? voterHex;
        const userStake = hexToBigInt(t[3]);
        const votePower = hexToBigInt(t[4]);

        byOption[option].count += 1;
        byOption[option].power += votePower;
        totalPower += votePower;

        const m = perCategoryAddresses[option];
        const prev = m.get(voterAddr) ?? { stake: 0n, power: 0n, count: 0 };
        m.set(voterAddr, { stake: prev.stake + userStake, power: prev.power + votePower, count: prev.count + 1 });

        // delegation source label by the contract in _source.address
        const src = s.address ?? "others";
        const label = DELEGATION_LABELS[src] ?? "others";
        delegationBreakdown.set(label, (delegationBreakdown.get(label) ?? 0n) + votePower);
      }
    }

    const pieDataOptions = Object.values(byOption).map((x) => ({ name: x.option, value: Number(x.power) }));

    const pieDelegation = Array.from(delegationBreakdown.entries()).map(([name, power]) => ({ name, value: Number(power) }));

    const topPerCategory = (opt: "yes" | "no" | "abstain" | "veto" | "unknown") =>
      Array.from(perCategoryAddresses[opt].entries())
        .map(([addr, v]) => ({ address: addr, stake: v.stake, power: v.power, count: v.count }))
        .sort((a, b) => (a.stake === b.stake ? Number(b.power - a.power) : Number(b.stake - a.stake)))
        .slice(0, 50);

    return {
      byOption,
      totalPower,
      pieDataOptions,
      pieDelegation,
      lists: {
        yes: topPerCategory("yes"),
        no: topPerCategory("no"),
        abstain: topPerCategory("abstain"),
        veto: topPerCategory("veto"),
        unknown: topPerCategory("unknown"),
      },
    };
  }, [rawHits]);

  const optionCards = ["yes", "no", "abstain", "veto", "unknown"].map((k) => {
    const x = (stats.byOption as any)[k];
    return (
      <Card key={k} className="rounded-2xl shadow-sm">
        <CardContent className="p-4">
          <div className="text-sm uppercase tracking-wide text-gray-500">{k}</div>
          <div className="text-2xl font-semibold mt-1">{x.count.toLocaleString()} votes</div>
          <div className="text-xs text-gray-500">Power: {formatEgld(BigInt(x.power))}</div>
        </CardContent>
      </Card>
    );
  });

  const Table = ({ rows }: { rows: { address: string; stake: bigint; power: bigint; count: number }[] }) => (
    <div className="overflow-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2 pr-4">Address</th>
            <th className="py-2 pr-4">User Stake</th>
            <th className="py-2 pr-4">Vote Power</th>
            <th className="py-2 pr-4">Events</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address} className="border-b hover:bg-gray-50">
              <td className="py-2 pr-4 font-mono">{r.address}</td>
              <td className="py-2 pr-4">{formatEgld(r.stake)}</td>
              <td className="py-2 pr-4">{formatEgld(r.power)}</td>
              <td className="py-2 pr-4">{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="p-6 space-y-6">
      <motion.h1 initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="text-3xl font-bold">
        MultiversX Governance Dashboard
      </motion.h1>

      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap gap-3 items-center">
          <div className="text-sm text-gray-600">Querying ES index for events where address/logAddress =</div>
          <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">{GOVERNANCE_SC}</code>
          <div className="ml-auto flex gap-2 items-center">
            <Input
              type="number"
              min={100}
              max={50000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-32"
              placeholder="size"
            />
            <Button onClick={fetchData} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="text-red-600">Error fetching data: {error}. If this is a CORS tantrum, use a proxy or run locally.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">{optionCards}</div>

      <Card className="rounded-2xl">
        <CardContent className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-80">
            <div className="text-sm mb-2 font-medium">Voting Options (by voting power)</div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats.pieDataOptions} dataKey="value" nameKey="name" label outerRadius={120} />
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="h-80">
            <div className="text-sm mb-2 font-medium">Delegated Votes by Source (by voting power)</div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats.pieDelegation} dataKey="value" nameKey="name" label outerRadius={120} />
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">Total Voting Power</div>
          <div className="text-2xl font-semibold">{formatEgld(stats.totalPower)}</div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">YES — Top voters by user stake</div><Table rows={stats.lists.yes} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">NO — Top voters by user stake</div><Table rows={stats.lists.no} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">ABSTAIN — Top voters by user stake</div><Table rows={stats.lists.abstain} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">VETO — Top voters by user stake</div><Table rows={stats.lists.veto} /></CardContent></Card>
      </div>

      <div className="text-xs text-gray-500">
        Notes: Direct `vote` events are aggregated and don't expose per-address voters. Delegated votes list shows voters decoded from topic[2]. Amounts assume 18 decimals.
      </div>
    </div>
  );
}
