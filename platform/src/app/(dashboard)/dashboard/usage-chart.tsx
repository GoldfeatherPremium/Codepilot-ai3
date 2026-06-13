"use client";

import {
  Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { formatTokens } from "@/lib/utils";

export function UsageChart({ series }: { series: { day: string; tokens: number; cost: number }[] }) {
  if (!series.length) {
    return <p className="py-10 text-center text-sm text-faint">No usage recorded yet.</p>;
  }

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="phosphorFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(38 96% 56%)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="hsl(38 96% 56%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="hsl(240 5% 16%)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: "hsl(240 4% 46%)", fontSize: 11 }}
            tickFormatter={(d: string) => d.slice(5)}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "hsl(240 4% 46%)", fontSize: 11 }}
            tickFormatter={(v: number) => formatTokens(v)}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(240 6% 9%)",
              border: "1px solid hsl(240 5% 16%)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "hsl(240 4% 66%)" }}
            formatter={(value: number, name: string) =>
              name === "tokens" ? [formatTokens(value), "tokens"] : [`$${Number(value).toFixed(4)}`, "cost"]
            }
          />
          <Area
            type="monotone"
            dataKey="tokens"
            stroke="hsl(38 96% 56%)"
            strokeWidth={1.5}
            fill="url(#phosphorFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
