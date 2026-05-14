import { useState, useEffect, useMemo } from 'react';
import { Plus, BarChart2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsWidgetsStore } from '@/stores/analyticsWidgetsStore';
import { useCustomColumnsStore } from '@/stores/customColumnsStore';
import { useSalesDataStore } from '@/stores/salesDataStore';
import { AnalyticsWidgetCard } from './AnalyticsWidgetCard';
import { AnalyticsWidgetBuilder } from './AnalyticsWidgetBuilder';
import { toast } from '@/hooks/use-toast';
import { detectProductFields } from '@/lib/columnDetection';

// Safely evaluate a custom column formula
function evalCustomFormula(formula, row) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('row', `"use strict"; return (${formula})`);
    const result = fn(row);
    // Support { value, color } objects — extract numeric value
    if (result !== null && result !== undefined && typeof result === 'object' && 'value' in result) {
      return result.value;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * AnalyticsSection — shown above the products table in Index.jsx.
 * 
 * Props:
 *   organizationId  — string  — current org id
 *   filteredRows    — array   — the same rows the table is showing (post-filter)
 */
export function AnalyticsSection({ organizationId, filteredRows = [] }) {
  const { widgets, isLoading, loadWidgets, addWidget, removeWidget } = useAnalyticsWidgetsStore();
  const { customColumns, loadCustomColumns } = useCustomColumnsStore();
  const salesMap = useSalesDataStore((state) => state.salesMap);
  const [builderOpen, setBuilderOpen] = useState(false);

  // Load custom columns for this org
  useEffect(() => {
    if (organizationId) loadCustomColumns(organizationId);
  }, [organizationId, loadCustomColumns]);

  // Enrich filteredRows with sales data + computed custom column values
  const enrichedRows = useMemo(() => {
    return filteredRows.map((row) => {
      const sku = row.sku || row.variantSku;
      const sales = sku ? (salesMap.get(sku) ?? { qty: 0, amount: 0 }) : { qty: 0, amount: 0 };
      const salesFields = {
        __sales_qty__: sales.qty,
        __sales_amount__: sales.amount,
      };
      if (!customColumns.length) return { ...row, ...salesFields };
      const extra = {};
      for (const cc of customColumns) {
        extra[`__custom__${cc.id}`] = evalCustomFormula(cc.formula, row);
      }
      return { ...row, ...salesFields, ...extra };
    });
  }, [filteredRows, salesMap, customColumns]);

  // Extra column descriptors to pass to the builder (custom columns)
  const extraColumns = useMemo(
    () => customColumns.map((cc) => ({ key: `__custom__${cc.id}`, label: cc.name })),
    [customColumns]
  );

  // Full column list for the builder: detected fields from the actual data + custom columns
  const allAvailableColumns = useMemo(() => {
    const detected = detectProductFields(filteredRows);
    const detectedKeys = new Set(detected.map((c) => c.key));
    const customCols = extraColumns.filter((c) => !detectedKeys.has(c.key));
    return [...detected, ...customCols];
  }, [filteredRows, extraColumns]);

  // Load widgets whenever the org changes
  useEffect(() => {
    if (organizationId) loadWidgets(organizationId);
  }, [organizationId, loadWidgets]);

  const handleSave = async (config) => {
    await addWidget(organizationId, config);
    toast({ title: 'Widget added', description: config.title });
  };

  const handleRemove = async (widgetId) => {
    try {
      await removeWidget(widgetId);
    } catch (e) {
      toast({ title: 'Failed to remove widget', description: e.message, variant: 'destructive' });
    }
  };

  // Determine if there's anything to show
  const hasWidgets = widgets.length > 0;

  // Don't render the entire section if org isn't ready
  if (!organizationId) return null;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Analytics</span>
          {hasWidgets && (
            <span className="text-xs text-muted-foreground">({widgets.length})</span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 h-8 text-xs"
          onClick={() => setBuilderOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Widget
        </Button>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[80px] rounded-lg" />
          ))}
        </div>
      )}

      {/* Widget grid */}
      {!isLoading && hasWidgets && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {widgets.map((widget) => (
            <AnalyticsWidgetCard
              key={widget.id}
              widget={widget}
              filteredRows={enrichedRows}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {/* Empty state: only show if not loading and no widgets yet */}
      {!isLoading && !hasWidgets && (
        <div
          className="border border-dashed border-border rounded-lg px-4 py-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => setBuilderOpen(true)}
        >
          <BarChart2 className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No analytics widgets yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click <strong>Add Widget</strong> to create a summary card or chart that reacts to your filters.
          </p>
        </div>
      )}

      {/* Builder dialog */}
      <AnalyticsWidgetBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        onSave={handleSave}
        sampleRows={enrichedRows}
        extraColumns={extraColumns}
        availableColumns={allAvailableColumns}
      />
    </div>
  );
}
