import { useMemo } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Palette for charts
const COLORS = [
  '#6366f1', '#22d3ee', '#f59e0b', '#10b981', '#f43f5e',
  '#8b5cf6', '#06b6d4', '#84cc16', '#ec4899', '#14b8a6',
];

/**
 * Compute the aggregate value or grouped data from filtered rows + widget config.
 */
function computeWidgetData(rows, widget) {
  if (!rows || rows.length === 0) return null;

  // Custom formula always produces a scalar for "card", or can return an array for charts
  if (widget.aggregation === 'custom' && widget.formula) {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('rows', `"use strict"; return (${widget.formula})`);
      return fn(rows);
    } catch {
      return null;
    }
  }

  const col = widget.column;

  // Card: single scalar
  if (widget.displayType === 'card') {
    const nums = rows.map((r) => parseFloat(r[col])).filter((n) => !isNaN(n));
    if (widget.aggregation === 'count') return rows.length;
    if (nums.length === 0) return null;
    if (widget.aggregation === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (widget.aggregation === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (widget.aggregation === 'min') return Math.min(...nums);
    if (widget.aggregation === 'max') return Math.max(...nums);
    return null;
  }

  // Charts: group by dimension, then aggregate per group
  const groupCol = widget.groupByColumn || 'vendor';
  const groupMap = new Map();

  for (const row of rows) {
    const groupKey = String(row[groupCol] ?? '(none)');
    if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
    groupMap.get(groupKey).push(row);
  }

  const chartData = [];
  for (const [name, groupRows] of groupMap) {
    let value = 0;
    if (widget.aggregation === 'count') {
      value = groupRows.length;
    } else {
      const nums = groupRows.map((r) => parseFloat(r[col])).filter((n) => !isNaN(n));
      if (nums.length > 0) {
        if (widget.aggregation === 'sum') value = nums.reduce((a, b) => a + b, 0);
        else if (widget.aggregation === 'avg') value = nums.reduce((a, b) => a + b, 0) / nums.length;
        else if (widget.aggregation === 'min') value = Math.min(...nums);
        else if (widget.aggregation === 'max') value = Math.max(...nums);
      }
    }
    chartData.push({ name, value: parseFloat(value.toFixed(2)) });
  }

  // Sort descending, cap at 15 groups for readability
  return chartData.sort((a, b) => b.value - a.value).slice(0, 15);
}

function formatValue(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') {
    return val >= 1000
      ? val.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : val.toFixed(2).replace(/\.00$/, '');
  }
  return String(val);
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 text-sm shadow-md">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>{formatValue(p.value)}</p>
      ))}
    </div>
  );
};

export function AnalyticsWidgetCard({ widget, filteredRows, onRemove }) {
  const data = useMemo(() => computeWidgetData(filteredRows, widget), [filteredRows, widget]);

  const isChart = widget.displayType !== 'card';
  const isScalar = !isChart || !Array.isArray(data);

  return (
    <div className="glass-card rounded-lg p-4 relative group">
      {/* Remove button */}
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onRemove(widget.id)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <p className="text-xs font-medium text-muted-foreground mb-1 truncate pr-6">{widget.title}</p>

      {/* Card view */}
      {(widget.displayType === 'card' || isScalar) && (
        <p className="text-2xl font-bold tracking-tight">
          {data === null ? '—' : formatValue(data)}
        </p>
      )}

      {/* Bar chart */}
      {widget.displayType === 'bar' && Array.isArray(data) && (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 24, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              angle={-30}
              textAnchor="end"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={40} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {/* Pie chart */}
      {widget.displayType === 'pie' && Array.isArray(data) && (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={70}
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      )}

      {/* Line chart */}
      {widget.displayType === 'line' && Array.isArray(data) && (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 24, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              angle={-30}
              textAnchor="end"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={40} />
            <Tooltip content={<CustomTooltip />} />
            <Line type="monotone" dataKey="value" stroke={COLORS[0]} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Area chart */}
      {widget.displayType === 'area' && Array.isArray(data) && (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 24, left: 4 }}>
            <defs>
              <linearGradient id={`grad-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS[0]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={COLORS[0]} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              angle={-30}
              textAnchor="end"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={40} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="value"
              stroke={COLORS[0]}
              strokeWidth={2}
              fill={`url(#grad-${widget.id})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
