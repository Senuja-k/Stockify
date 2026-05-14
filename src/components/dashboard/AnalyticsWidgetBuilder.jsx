import { useState, useMemo, useRef } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, BarChart2, PieChart, TrendingUp, CreditCard, AreaChart, Code2, Sliders } from 'lucide-react';
import { cn } from '@/lib/utils';

const DISPLAY_TYPES = [
  { value: 'card',  label: 'Summary Card',  icon: CreditCard },
  { value: 'bar',   label: 'Bar Chart',     icon: BarChart2 },
  { value: 'pie',   label: 'Pie Chart',     icon: PieChart },
  { value: 'line',  label: 'Line Chart',    icon: TrendingUp },
  { value: 'area',  label: 'Area Chart',    icon: AreaChart },
];

const AGGREGATIONS = [
  { value: 'sum',    label: 'Sum' },
  { value: 'count',  label: 'Count (rows)' },
  { value: 'avg',    label: 'Average' },
  { value: 'min',    label: 'Minimum' },
  { value: 'max',    label: 'Maximum' },
];

// Fallback columns when none are passed in
const FALLBACK_COLUMNS = [
  { key: 'variantPrice',    label: 'Variant Price' },
  { key: 'totalInventory',  label: 'Total Inventory' },
  { key: 'vendor',          label: 'Vendor' },
  { key: 'productType',     label: 'Product Type' },
  { key: 'title',           label: 'Product Title' },
  { key: 'sku',             label: 'SKU' },
  { key: 'compareAtPrice',  label: 'Compare At Price' },
  { key: 'storeName',       label: 'Store' },
];

// String-type keys that make sense as group-by dimensions
const GROUP_BY_KEYS = new Set(['vendor', 'productType', 'storeName', 'variantTitle', 'status', 'title']);

const FORMULA_EXAMPLES = [
  {
    label: 'Total Revenue',
    code: `rows.reduce((sum, r) => sum + (parseFloat(r.variantPrice) || 0) * (parseInt(r.totalInventory) || 0), 0).toFixed(2)`,
  },
  {
    label: 'Avg Price',
    code: `(rows.reduce((s, r) => s + (parseFloat(r.variantPrice) || 0), 0) / rows.length).toFixed(2)`,
  },
  {
    label: 'Out-of-stock count',
    code: `rows.filter(r => (parseInt(r.totalInventory) || 0) === 0).length`,
  },
  {
    label: 'Unique vendors',
    code: `new Set(rows.map(r => r.vendor).filter(Boolean)).size`,
  },
];

function previewWidget(mode, config, sampleRows) {
  if (!sampleRows || sampleRows.length === 0) return '—';
  try {
    if (mode === 'code') {
      if (!config.formula?.trim()) return '—';
      // Try expression mode first; fall back to block mode for multi-statement code
      // eslint-disable-next-line no-new-func
      let fn;
      try { fn = new Function('rows', `"use strict"; return (${config.formula})`); }
      catch { fn = new Function('rows', `"use strict"; ${config.formula}`); }
      const result = fn(sampleRows);
      if (result === null || result === undefined) return '—';
      // Chart formulas return an array of {name, value} — show a concise summary
      if (Array.isArray(result)) {
        if (result.length === 0) return 'no data';
        return result.slice(0, 3).map((d) => `${d.name}: ${d.value}`).join(' · ')
          + (result.length > 3 ? ` · +${result.length - 3} more` : '');
      }
      return String(result);
    }
    const col = config.column;
    if (!col) return '—';
    const nums = sampleRows.map((r) => parseFloat(r[col])).filter((n) => !isNaN(n));
    if (config.aggregation === 'count') return sampleRows.length;
    if (nums.length === 0) return 'no numeric values';
    if (config.aggregation === 'sum') return nums.reduce((a, b) => a + b, 0).toFixed(2);
    if (config.aggregation === 'avg') return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
    if (config.aggregation === 'min') return Math.min(...nums).toFixed(2);
    if (config.aggregation === 'max') return Math.max(...nums).toFixed(2);
    return '—';
  } catch (e) {
    return `⚠ ${e.message}`;
  }
}

export function AnalyticsWidgetBuilder({ open, onOpenChange, onSave, sampleRows = [], extraColumns = [], availableColumns: columnsProp }) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('simple'); // 'simple' | 'code'
  const [displayType, setDisplayType] = useState('card');
  const [aggregation, setAggregation] = useState('sum');
  const [column, setColumn] = useState('variantPrice');
  const [formula, setFormula] = useState('');
  const [groupByColumn, setGroupByColumn] = useState('vendor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const formulaRef = useRef(null);

  const needsGroupBy = displayType !== 'card';

  const allColumns = useMemo(() => {
    const base = columnsProp?.length ? columnsProp : FALLBACK_COLUMNS;
    const baseKeys = new Set(base.map((c) => c.key));
    const extras = extraColumns.filter((c) => !baseKeys.has(c.key));
    return [...base, ...extras];
  }, [columnsProp, extraColumns]);

  const groupByColumns = useMemo(() => {
    return allColumns.filter((c) =>
      GROUP_BY_KEYS.has(c.key) || (!c.key.startsWith('__custom__') && (c.type === 'string' || !c.type))
    ).slice(0, 20);
  }, [allColumns]);

  const preview = useMemo(
    () => previewWidget(mode, { aggregation, column, formula }, sampleRows.slice(0, 200)),
    [mode, aggregation, column, formula, sampleRows]
  );

  const insertAtCursor = (text) => {
    const textarea = formulaRef.current;
    if (textarea) {
      const start = textarea.selectionStart ?? formula.length;
      const end = textarea.selectionEnd ?? formula.length;
      const next = formula.slice(0, start) + text + formula.slice(end);
      setFormula(next);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + text.length, start + text.length);
      });
    } else {
      setFormula((prev) => prev + text);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    if (mode === 'code' && !formula.trim()) { setError('Formula is required'); return; }
    if (String(preview).startsWith('⚠')) { setError('Fix the formula error before saving'); return; }
    setError('');
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        displayType,
        aggregation: mode === 'code' ? 'custom' : aggregation,
        column: mode === 'code' ? null : column,
        formula: mode === 'code' ? formula.trim() : null,
        groupByColumn: needsGroupBy ? groupByColumn : null,
      });
      setTitle(''); setMode('simple'); setDisplayType('card'); setAggregation('sum');
      setColumn('variantPrice'); setFormula(''); setGroupByColumn('vendor');
      onOpenChange(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Analytics Widget</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Title */}
          <div className="space-y-1.5">
            <Label>Widget Title</Label>
            <Input
              placeholder="e.g. Total Revenue"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-muted rounded-lg">
            <button
              type="button"
              onClick={() => setMode('simple')}
              className={cn(
                'flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                mode === 'simple'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Sliders className="h-4 w-4" />
              Simple
            </button>
            <button
              type="button"
              onClick={() => setMode('code')}
              className={cn(
                'flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                mode === 'code'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Code2 className="h-4 w-4" />
              Custom Code
            </button>
          </div>

          {/* Display type */}
          <div className="space-y-1.5">
            <Label>Display Type</Label>
            <div className="grid grid-cols-5 gap-2">
              {DISPLAY_TYPES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDisplayType(value)}
                  className={cn(
                    'flex flex-col items-center gap-1 p-2 rounded-lg border text-xs transition-colors',
                    displayType === value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:border-primary/50 text-muted-foreground'
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── SIMPLE MODE ── */}
          {mode === 'simple' && (
            <>
              <div className="space-y-1.5">
                <Label>Aggregation</Label>
                <Select value={aggregation} onValueChange={setAggregation}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AGGREGATIONS.map((a) => (
                      <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Column</Label>
                <Select value={column} onValueChange={setColumn}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {allColumns.filter((c) => !c.key.startsWith('__custom__')).map((c) => (
                      <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                    ))}
                    {allColumns.filter((c) => c.key.startsWith('__custom__')).length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-t mt-1 pt-2">Custom Columns</div>
                        {allColumns.filter((c) => c.key.startsWith('__custom__')).map((c) => (
                          <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* ── CUSTOM CODE MODE ── */}
          {mode === 'code' && (
            <div className="space-y-3">
              {/* Quick examples */}
              <div className="space-y-1.5">
                <Label>Quick Examples</Label>
                <div className="flex flex-wrap gap-1.5">
                  {FORMULA_EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      onClick={() => setFormula(ex.code)}
                      className="text-xs px-2 py-1 rounded-full border border-border bg-muted hover:bg-primary/10 hover:text-primary hover:border-primary/40 transition-colors"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Formula editor */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>
                    Formula
                    <Badge variant="secondary" className="ml-2 text-xs font-mono">JavaScript</Badge>
                  </Label>
                  {formula && (
                    <button
                      type="button"
                      onClick={() => setFormula('')}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <Textarea
                  ref={formulaRef}
                  placeholder={`rows.reduce((sum, r) => sum + parseFloat(r.variantPrice || 0), 0).toFixed(2)`}
                  value={formula}
                  onChange={(e) => setFormula(e.target.value)}
                  className="font-mono text-xs min-h-[100px] resize-y"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  <code className="bg-muted px-1 py-0.5 rounded font-mono">rows</code> — the filtered product array.{' '}
                  <code className="bg-muted px-1 py-0.5 rounded font-mono">r.field</code> — access a field on each row.
                </p>
              </div>

              {/* Column reference chips */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Click a column to insert it</Label>
                <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto rounded-md border bg-muted/40 p-2">
                  {allColumns.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      title={c.label}
                      onClick={() => insertAtCursor(`r.${c.key}`)}
                      className="text-xs px-1.5 py-0.5 rounded bg-background hover:bg-primary/10 hover:text-primary font-mono border border-border transition-colors"
                    >
                      {c.key}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Group by (charts only) */}
          {needsGroupBy && (
            <div className="space-y-1.5">
              <Label>Group By</Label>
              <Select value={groupByColumn} onValueChange={setGroupByColumn}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {groupByColumns.map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Live preview */}
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground text-xs">Preview (first 200 rows): </span>
            <span className={String(preview).startsWith('⚠') ? 'text-destructive font-mono text-xs' : 'font-medium'}>
              {preview}
            </span>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Add Widget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
