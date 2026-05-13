import { useState, useMemo } from 'react';
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
import { AlertCircle, BarChart2, PieChart, TrendingUp, CreditCard, AreaChart } from 'lucide-react';

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
  { value: 'custom', label: 'Custom formula' },
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
const GROUP_BY_KEYS = new Set(['vendor', 'productType', 'storeName', 'variantTitle', 'status', 'productType', 'title']);

/**
 * Evaluates a widget config against a sample row and the full rows array.
 * Returns a string/number preview or an error string.
 */
function previewWidget(config, sampleRows) {
  if (!sampleRows || sampleRows.length === 0) return '—';
  try {
    if (config.aggregation === 'custom') {
      if (!config.formula?.trim()) return '—';
      // eslint-disable-next-line no-new-func
      const fn = new Function('rows', `"use strict"; return (${config.formula})`);
      const result = fn(sampleRows);
      return result !== null && result !== undefined ? String(result) : '—';
    }
    const col = config.column;
    if (!col) return '—';
    const nums = sampleRows
      .map((r) => parseFloat(r[col]))
      .filter((n) => !isNaN(n));
    if (nums.length === 0) return 'no numeric values';
    if (config.aggregation === 'sum') return nums.reduce((a, b) => a + b, 0).toFixed(2);
    if (config.aggregation === 'count') return sampleRows.length;
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
  const [displayType, setDisplayType] = useState('card');
  const [aggregation, setAggregation] = useState('sum');
  const [column, setColumn] = useState('variantPrice');
  const [formula, setFormula] = useState('');
  const [groupByColumn, setGroupByColumn] = useState('vendor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const needsGroupBy = displayType !== 'card';
  const needsColumn = aggregation !== 'custom';

  // All selectable columns: prop-driven or fallback, then append custom
  const allColumns = useMemo(() => {
    const base = columnsProp?.length ? columnsProp : FALLBACK_COLUMNS;
    const baseKeys = new Set(base.map((c) => c.key));
    const extras = extraColumns.filter((c) => !baseKeys.has(c.key));
    return [...base, ...extras];
  }, [columnsProp, extraColumns]);

  // String-type columns that work as group-by dimensions
  const groupByColumns = useMemo(() => {
    return allColumns.filter((c) =>
      GROUP_BY_KEYS.has(c.key) || (!c.key.startsWith('__custom__') && (c.type === 'string' || !c.type))
    ).slice(0, 20);
  }, [allColumns]);

  const preview = useMemo(
    () => previewWidget({ aggregation, column, formula }, sampleRows.slice(0, 200)),
    [aggregation, column, formula, sampleRows]
  );

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    if (aggregation === 'custom' && !formula.trim()) { setError('Formula is required for custom aggregation'); return; }
    if (needsColumn && aggregation !== 'custom' && !column) { setError('Select a column'); return; }
    if (String(preview).startsWith('⚠')) { setError('Fix the formula error before saving'); return; }
    setError('');
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        displayType,
        aggregation,
        column: needsColumn ? column : null,
        formula: aggregation === 'custom' ? formula.trim() : null,
        groupByColumn: needsGroupBy ? groupByColumn : null,
      });
      // Reset
      setTitle(''); setDisplayType('card'); setAggregation('sum');
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

          {/* Display type */}
          <div className="space-y-1.5">
            <Label>Display Type</Label>
            <div className="grid grid-cols-5 gap-2">
              {DISPLAY_TYPES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDisplayType(value)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-xs transition-colors ${
                    displayType === value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:border-primary/50 text-muted-foreground'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Aggregation */}
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

          {/* Column (hidden for custom) */}
          {aggregation !== 'custom' && (
            <div className="space-y-1.5">
              <Label>Column</Label>
              <Select value={column} onValueChange={setColumn}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {allColumns
                    .filter((c) => !c.key.startsWith('__custom__'))
                    .map((c) => (
                      <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                    ))}
                  {allColumns.filter((c) => c.key.startsWith('__custom__')).length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-t mt-1 pt-2">Custom Columns</div>
                      {allColumns
                        .filter((c) => c.key.startsWith('__custom__'))
                        .map((c) => (
                          <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                        ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Custom formula */}
          {aggregation === 'custom' && (
            <div className="space-y-1.5">
              <Label>Formula <Badge variant="secondary" className="ml-1 text-xs">JS</Badge></Label>
              <Textarea
                placeholder={`rows.reduce((sum, r) => sum + parseFloat(r.variantPrice || 0), 0).toFixed(2)`}
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                className="font-mono text-xs min-h-[80px]"
              />
              <p className="text-xs text-muted-foreground">
                <code>rows</code> is the filtered product array. Each row has fields like{' '}
                <code>variantPrice</code>, <code>totalInventory</code>, <code>vendor</code>, etc.
              </p>
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
            <span className={String(preview).startsWith('⚠') ? 'text-destructive' : 'font-medium'}>
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
