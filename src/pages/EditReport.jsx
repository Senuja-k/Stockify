import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReportManagement } from '../stores/reportManagement';
import { useStoreManagement } from '../stores/storeManagement';
import { useCustomColumnsStore } from '../stores/customColumnsStore';
import { auth } from '../lib/supabase';
import { getAllVariantsByStore } from '../lib/shopify-sync-utils';
import { detectProductFields } from '../lib/columnDetection';
import { applyFilters } from '../lib/filterEvaluation';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { ScrollArea } from '../components/ui/scroll-area';
import { useToast } from '../components/ui/use-toast';
import { AlertCircle, Loader2, ArrowLeft, GripVertical, Code2, Columns, Play, RotateCcw } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import { Textarea } from '../components/ui/textarea';
import { SimpleHeader } from '../components/dashboard/SimpleHeader';
import { ProductsTable } from '../components/dashboard/ProductsTable';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * REPORT EDITOR (Owner/Admin Mode)
 * 
 * This is where report owners/admins configure the MASTER report:
 * - Set columns, filters, sorting, date ranges
 * - Changes ARE saved to the database
 * - Changes DO affect the master report shown to all viewers
 * - This is different from PublicReport (viewer mode) where changes are local only
 * 
 * When saved, the master config is used default/initial state
 * for all viewers accessing the public/shared link.
 */

// Sortable stat card for drag-and-drop reordering
function SortableStatCard({ id, label, value }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="rounded-lg border bg-muted/40 px-4 py-3 relative group">
      <div
        {...attributes}
        {...listeners}
        className="absolute top-2 right-2 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-60 transition-opacity"
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground mb-1 pr-5">{label}</p>
      <p className="text-lg font-semibold leading-none">{value ?? '—'}</p>
    </div>
  );
}

// Sortable column item component for drag-and-drop
function SortableColumnItem({ 
  id, 
  label, 
  isSelected, 
  onToggle 
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center space-x-2 bg-background border rounded-md p-2 hover:bg-accent/50"
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </div>
      <Checkbox
        id={`col-${id}`}
        checked={isSelected}
        onCheckedChange={onToggle}
      />
      <label
        htmlFor={`col-${id}`}
        className="text-xs font-medium leading-none cursor-pointer flex-1"
      >
        {label}
      </label>
    </div>
  );
}

export function EditReport() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { reports, updateReport } = useReportManagement();
  const { stores } = useStoreManagement();
  const { customColumns, loadCustomColumns } = useCustomColumnsStore();

  const report = reportId ? reports.find((r) => r.id === reportId) : undefined;

  // Load custom columns whenever the report's org is known
  useEffect(() => {
    if (report?.organizationId) loadCustomColumns(report.organizationId);
  }, [report?.organizationId, loadCustomColumns]);

  const [reportName, setReportName] = useState('');
  const [selectedColumns, setSelectedColumns] = useState([]);
  const [availableColumns, setAvailableColumns] = useState([]);
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [filterConfig, setFilterConfig] = useState({ items: [] });

  // Custom code editor state
  const [customCode, setCustomCode] = useState('');
  const [codeError, setCodeError] = useState(null);
  const [codeColumns, setCodeColumns] = useState([]); // evaluated column defs
  const [codeStats, setCodeStats] = useState([]); // stat card definitions
  const [statOrder, setStatOrder] = useState([]); // display order of stat keys
  const [computedProducts, setComputedProducts] = useState(null); // null = use raw products

  // Compute stat values reactively from filtered products, respecting statOrder
  const statValues = useMemo(() => {
    if (!codeStats.length) return [];
    const base = computedProducts ?? products;
    const filtered = filterConfig?.items?.length ? applyFilters(base, filterConfig) : base;
    const mapped = codeStats.map((stat) => {
      try { return { key: stat.key, label: stat.label, value: stat.compute(filtered) }; }
      catch { return { key: stat.key, label: stat.label, value: '—' }; }
    });
    if (!statOrder.length) return mapped;
    return [...mapped].sort((a, b) => {
      const ai = statOrder.indexOf(a.key);
      const bi = statOrder.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [codeStats, statOrder, computedProducts, products, filterConfig]);

  const DEFAULT_CODE = `// Return an object with \`columns\` and/or \`stats\`.
//
// columns — per-row computed fields added to the table.
//   compute(row) receives a single product row.
//
// stats — summary label cards shown above the table.
//   compute(rows) receives ALL currently-filtered rows.
//
// Example:
return {
  columns: [
    {
      key: 'stockValue',
      label: 'Stock Value',
      compute: (row) => {
        const price = parseFloat(row.variantPrice) || 0;
        const qty = parseInt(row.totalInventory) || 0;
        return (price * qty).toFixed(2);
      },
    },
  ],
  stats: [
    {
      key: 'totalQty',
      label: 'Total Quantity',
      compute: (rows) =>
        rows.reduce((sum, r) => sum + (parseInt(r.totalInventory) || 0), 0).toLocaleString(),
    },
    {
      key: 'totalValue',
      label: 'Total Stock Value',
      compute: (rows) => {
        const total = rows.reduce(
          (sum, r) => sum + (parseFloat(r.variantPrice) || 0) * (parseInt(r.totalInventory) || 0),
          0
        );
        return '$' + total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      },
    },
  ],
};
`;

  // Drag-and-drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle drag end for column reordering
  const handleDragEnd = (event) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = availableColumns.findIndex((col) => col.key === active.id);
      const newIndex = availableColumns.findIndex((col) => col.key === over.id);

      const newOrder = arrayMove(availableColumns, oldIndex, newIndex);
      setAvailableColumns(newOrder);
      
      // Reorder selected columns to match new order
      const newSelectedOrder = newOrder
        .filter(col => selectedColumns.includes(col.key))
        .map(col => col.key);
      setSelectedColumns(newSelectedOrder);
    }
  };

  // Handle drag end for stat card reordering
  const handleStatDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setStatOrder((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  // Load report data and products
  const loadReportData = useCallback(async (showRefreshingState = false) => {
    if (!report) {
      setIsLoading(false);
      return;
    }

    if (showRefreshingState) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    
    try {
        // Set report details
        setReportName(report.name);
        setSelectedColumns(report.selectedColumns);
        setFilterConfig(report.filterConfig || { items: [] });
        setCustomCode(report.customCode || '');

        // Load products
        const session = await auth.getSession();
        const user = session.data.session?.user;
        if (!user) {
          throw new Error('User not authenticated');
        }

        let allProducts;
        let availableStoreIds = [];
        const organizationId = report.organizationId;

        if (report.storeId === 'all-stores') {
          // Filter out deleted stores
          availableStoreIds = stores.map(s => s.id);
          if (availableStoreIds.length === 0) {
            // All stores deleted
            setProducts([]);
            setAvailableColumns([]);
            setIsLoading(false);
            return;
          }
          allProducts = await getAllVariantsByStore(user.id, availableStoreIds, organizationId);
        } else {
          // Check if the report's store still exists
          const reportStore = stores.find(s => s.id === report.storeId);
          if (!reportStore) {
            // Store deleted - show empty state
            setProducts([]);
            setAvailableColumns([]);
            setIsLoading(false);
            return;
          }
          availableStoreIds = [report.storeId];
          allProducts = await getAllVariantsByStore(user.id, availableStoreIds, organizationId);
        }

        // Format products — getAllVariantsByStore already returns one row per variant
        // (variants: []) so flattenProductsWithVariants must NOT be called here;
        // it would take the no-variants path and overwrite sku/variantId/etc. to undefined.
        const flattenedProducts = allProducts.map((v) => ({
          ...v,
          id: v.id || v.shopify_product_id,
          title: v.title || '',
          status: v.status || 'UNKNOWN',
          storeId: v.store_id,
          storeName: stores.find(s => s.id === v.store_id)?.name || '',
        }));
        
        setProducts(flattenedProducts);

        // Detect available columns
        const detected = detectProductFields(flattenedProducts);

        // Auto-apply saved custom code so computed columns/stats show immediately
        const savedCode = (report.customCode || '').trim();
        if (savedCode) {
          try {
            // eslint-disable-next-line no-new-func
            const fn = new Function(savedCode);
            const raw = fn();
            const columns = Array.isArray(raw) ? raw : (raw?.columns || []);
            const stats = Array.isArray(raw) ? [] : (raw?.stats || []);
            if (columns.every((c) => c.key && c.label && typeof c.compute === 'function')) {
              const enriched = flattenedProducts.map((row) => {
                const extra = {};
                for (const col of columns) {
                  try { extra[col.key] = col.compute(row); } catch { extra[col.key] = ''; }
                }
                return { ...row, ...extra };
              });
              setCodeColumns(columns);
              setComputedProducts(enriched);
              for (const col of columns) {
                if (!detected.some((d) => d.key === col.key)) {
                  detected.push({ key: col.key, label: col.label });
                }
              }
            }
            if (stats.every((s) => s.key && s.label && typeof s.compute === 'function')) {
              setCodeStats(stats);
              // Restore saved stat order, fall back to code-defined order
              const savedOrder = report.codeStatOrder;
              const keys = stats.map((s) => s.key);
              if (Array.isArray(savedOrder) && savedOrder.length && savedOrder.every((k) => keys.includes(k))) {
                setStatOrder(savedOrder);
              } else {
                setStatOrder(keys);
              }
            }
          } catch {
            // silently skip auto-apply if code has errors
          }
        }

        // Append sales columns so they appear in the column picker
        const salesCols = [
          { key: '__sales_qty__', label: 'Sales Qty', type: 'sales_qty' },
          { key: '__sales_amount__', label: 'Sales Amount', type: 'sales_amount' },
        ];
        for (const sc of salesCols) {
          if (!detected.some((d) => d.key === sc.key)) detected.push(sc);
        }

        // Merge custom columns (dashboard-created) so they are always visible
        for (const cc of customColumns) {
          const key = `__custom__${cc.id}`;
          if (!detected.some((d) => d.key === key)) {
            detected.push({ key, label: cc.name, type: 'custom' });
          }
        }

        setAvailableColumns(detected);
      } catch (error) {
        toast({
          title: 'Error',
          description: 'Failed to load report data',
          variant: 'destructive',
        });
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
  }, [report, stores, toast, customColumns]);

  // Load on mount or when report/stores change
  useEffect(() => {
    loadReportData();
  }, [loadReportData]);

  // Merge custom columns into availableColumns whenever customColumns changes
  // (handles custom columns added after the report was first created)
  useEffect(() => {
    if (!customColumns.length) return;
    setAvailableColumns((prev) => {
      const existingKeys = new Set(prev.map((c) => c.key));
      const newCols = customColumns
        .filter((cc) => !existingKeys.has(`__custom__${cc.id}`))
        .map((cc) => ({ key: `__custom__${cc.id}`, label: cc.name, type: 'custom' }));
      if (!newCols.length) return prev;
      return [...prev, ...newCols];
    });
  }, [customColumns]);

  const handleSaveChanges = async () => {
    if (!report || !reportName.trim()) {
      toast({
        title: 'Error',
        description: 'Report name is required',
        variant: 'destructive',
      });
      return;
    }

    if (selectedColumns.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one column',
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);
    try {
      await updateReport(report.id, {
        name: reportName,
        selectedColumns,
        filterConfig,
        customCode,
        codeStatOrder: statOrder,
      });

      toast({
        title: 'Report Updated',
        description: 'Your changes have been saved successfully',
      });

      navigate('/custom-reports');
    } catch (error) {
      console.error('Failed to save report:', error);
      toast({
        title: 'Error',
        description: 'Failed to save report changes',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Evaluate the user's custom code and inject computed columns into the preview.
   * The code must return an array of { key, label, compute: (row) => value }.
   * Runs only in the owner's browser — safe as it's self-XSS scope.
   */
  const applyCode = () => {
    setCodeError(null);
    const code = (customCode || '').trim();
    if (!code) {
      setCodeColumns([]);
      setCodeStats([]);
      setComputedProducts(null);
      return;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(code);
      const raw = fn();

      // Support both old array format and new { columns, stats } format
      const columns = Array.isArray(raw) ? raw : (raw?.columns || []);
      const stats = Array.isArray(raw) ? [] : (raw?.stats || []);

      if (!Array.isArray(columns)) throw new Error('`columns` must be an array.');
      if (!Array.isArray(stats)) throw new Error('`stats` must be an array.');

      for (const col of columns) {
        if (!col.key || typeof col.key !== 'string') throw new Error('Each column needs a string `key`.');
        if (!col.label || typeof col.label !== 'string') throw new Error('Each column needs a string `label`.');
        if (typeof col.compute !== 'function') throw new Error(`Column "${col.key}" needs a compute(row) function.`);
      }
      for (const stat of stats) {
        if (!stat.key || typeof stat.key !== 'string') throw new Error('Each stat needs a string `key`.');
        if (!stat.label || typeof stat.label !== 'string') throw new Error('Each stat needs a string `label`.');
        if (typeof stat.compute !== 'function') throw new Error(`Stat "${stat.key}" needs a compute(rows) function.`);
      }

      // Apply column compute functions to every product row
      const enriched = products.map((row) => {
        const extra = {};
        for (const col of columns) {
          try { extra[col.key] = col.compute(row); } catch { extra[col.key] = ''; }
        }
        return { ...row, ...extra };
      });

      setCodeColumns(columns);
      setCodeStats(stats);
      setStatOrder(stats.map((s) => s.key));
      setComputedProducts(columns.length ? enriched : null);

      // Add code-defined columns to availableColumns if not already there
      setAvailableColumns((prev) => {
        const existing = new Set(prev.map((c) => c.key));
        const toAdd = columns.filter((c) => !existing.has(c.key)).map((c) => ({ key: c.key, label: c.label }));
        return [...prev, ...toAdd];
      });

      const parts = [];
      if (columns.length) parts.push(`${columns.length} column${columns.length > 1 ? 's' : ''}`);
      if (stats.length) parts.push(`${stats.length} stat${stats.length > 1 ? 's' : ''}`);
      toast({ title: 'Code applied', description: parts.join(' and ') + ' active.' });
    } catch (err) {
      setCodeError(err.message);
    }
  };

  const resetCode = () => {
    setCodeColumns([]);
    setCodeStats([]);
    setStatOrder([]);
    setComputedProducts(null);
    setCodeError(null);
    // Remove code-defined keys from availableColumns
    setAvailableColumns((prev) =>
      prev.filter((c) => !codeColumns.some((cc) => cc.key === c.key))
    );
  };

  // Report not found
  if (!isLoading && !report) {
    return (
      <div className="min-h-screen bg-background">
        <SimpleHeader title="Edit Report" showLogout={true} showHomeButton={true} />
        <div className="container mx-auto py-8 px-4">
          <Card className="border-destructive">
            <CardContent className="pt-8">
              <div className="text-center">
                <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
                <h1 className="text-xl font-bold mb-2">Report Not Found</h1>
                <p className="text-muted-foreground mb-6">
                  The report you're trying to edit doesn't exist.
                </p>
                <Button variant="outline" onClick={() => navigate('/custom-reports')}>
                  Back to Reports
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <SimpleHeader title="Edit Report" showLogout={true} showHomeButton={true} />
        <div className="container mx-auto py-12 px-4">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mr-2" />
            <p className="text-muted-foreground">Loading report...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <SimpleHeader 
        title={`Edit: ${reportName}`} 
        showLogout={true} 
        showHomeButton={true}
        onRefresh={() => loadReportData(true)}
        isRefreshing={isRefreshing}
      />

      <div className="container mx-auto py-8 px-4">
        <div className="mb-6">
          <Button
            variant="ghost"
            onClick={() => navigate('/custom-reports')}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Reports
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Editor Sidebar */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Report Settings</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Tabs defaultValue="columns" className="w-full">
                  <TabsList className="w-full rounded-none border-b grid grid-cols-2">
                    <TabsTrigger value="columns" className="text-xs gap-1.5">
                      <Columns className="h-3.5 w-3.5" />
                      Columns
                    </TabsTrigger>
                    <TabsTrigger value="code" className="text-xs gap-1.5">
                      <Code2 className="h-3.5 w-3.5" />
                      Code
                      {(codeColumns.length + codeStats.length) > 0 && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] ml-1">
                          {codeColumns.length + codeStats.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                  </TabsList>

                  {/* Columns Tab */}
                  <TabsContent value="columns" className="p-4 space-y-4 mt-0">
                    <div>
                      <Label htmlFor="report-name" className="text-sm">Report Name</Label>
                      <Input
                        id="report-name"
                        placeholder="Report name"
                        value={reportName}
                        onChange={(e) => setReportName(e.target.value)}
                        className="mt-2 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-sm">Columns to Display</Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        {selectedColumns.length} of {availableColumns.length} shown - Drag to reorder
                      </p>
                      <ScrollArea className="border rounded-md p-3 h-64">
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={handleDragEnd}
                        >
                          <SortableContext
                            items={availableColumns.map((col) => col.key)}
                            strategy={verticalListSortingStrategy}
                          >
                            <div className="space-y-2">
                              {availableColumns.map((col) => (
                                <SortableColumnItem
                                  key={col.key}
                                  id={col.key}
                                  label={
                                    codeColumns.find((c) => c.key === col.key)
                                      ? `${col.label ?? col.key} *`
                                      : (col.label ?? col.key)
                                  }
                                  isSelected={selectedColumns.includes(col.key)}
                                  onToggle={(checked) => {
                                    if (checked) {
                                      const newSelected = availableColumns
                                        .filter((c) => selectedColumns.includes(c.key) || c.key === col.key)
                                        .map((c) => c.key);
                                      setSelectedColumns(newSelected);
                                    } else {
                                      setSelectedColumns(selectedColumns.filter((c) => c !== col.key));
                                    }
                                  }}
                                />
                              ))}
                            </div>
                          </SortableContext>
                        </DndContext>
                      </ScrollArea>
                    </div>
                    <div className="border-t pt-4 space-y-2">
                      <Button onClick={handleSaveChanges} disabled={isSaving} className="w-full">
                        {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {isSaving ? 'Saving...' : 'Save Changes'}
                      </Button>
                      <Button variant="outline" onClick={() => navigate('/custom-reports')} className="w-full">
                        Cancel
                      </Button>
                    </div>
                  </TabsContent>

                  {/* Code Tab */}
                  <TabsContent value="code" className="p-4 space-y-3 mt-0">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">
                        Return <code className="text-xs bg-muted px-1 rounded">{'{ columns, stats }'}</code> to add computed fields and summary cards.
                      </p>
                      <p className="text-xs text-muted-foreground mb-3">
                        <strong>stats</strong> <code className="text-xs bg-muted px-1 rounded">compute(rows)</code> receives all filtered rows and returns a display value.
                      </p>
                    </div>
                    <Textarea
                      value={customCode}
                      onChange={(e) => setCustomCode(e.target.value)}
                      placeholder={DEFAULT_CODE}
                      className="font-mono text-xs min-h-[300px] resize-y bg-muted/30 leading-relaxed"
                      spellCheck={false}
                    />
                    {codeError && (
                      <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span className="font-mono break-all">{codeError}</span>
                      </div>
                    )}
                    {(codeColumns.length > 0 || codeStats.length > 0) && !codeError && (
                      <div className="text-xs text-green-600 bg-green-50 dark:bg-green-950/30 dark:text-green-400 rounded-md px-3 py-2 space-y-1">
                        {codeColumns.length > 0 && (
                          <div>{codeColumns.length} column{codeColumns.length > 1 ? 's' : ''}: {codeColumns.map((c) => c.label).join(', ')}</div>
                        )}
                        {codeStats.length > 0 && (
                          <div>{codeStats.length} stat{codeStats.length > 1 ? 's' : ''}: {codeStats.map((s) => s.label).join(', ')}</div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={applyCode} className="flex-1 gap-1.5">
                        <Play className="h-3.5 w-3.5" />
                        Apply
                      </Button>
                      {(codeColumns.length > 0 || codeStats.length > 0) && (
                        <Button size="sm" variant="outline" onClick={resetCode} className="gap-1.5">
                          <RotateCcw className="h-3.5 w-3.5" />
                          Reset
                        </Button>
                      )}
                    </div>
                    <div className="border-t pt-3">
                      <p className="text-xs font-medium mb-2 text-muted-foreground">Available fields on <code className="bg-muted px-1 rounded">row</code> (for columns):</p>
                      <div className="flex flex-wrap gap-1">
                        {['title','vendor','variantPrice','compareAtPrice','totalInventory','sku','productType','storeName','status','barcode','handle'].map((f) => (
                          <code key={f} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{f}</code>
                        ))}
                      </div>
                    </div>
                    <div className="border-t pt-3">
                      <Button onClick={handleSaveChanges} disabled={isSaving} className="w-full" size="sm">
                        {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {isSaving ? 'Saving...' : 'Save Report'}
                      </Button>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>

          {/* Preview */}
          <div className="lg:col-span-3">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Preview</CardTitle>
                  <div className="flex items-center gap-2">
                    {(codeColumns.length > 0 || codeStats.length > 0) && (
                      <Badge variant="outline" className="text-xs gap-1">
                        <Code2 className="h-3 w-3" />
                        {codeColumns.length + codeStats.length} custom
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {selectedColumns.length} column{selectedColumns.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {products.length === 0 && availableColumns.length === 0 ? (
                  <div className="text-center py-12">
                    <AlertCircle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">Data Not Available</h3>
                    <p className="text-muted-foreground text-sm">
                      The store(s) associated with this report have been deleted.
                      <br />
                      Please update the report or delete it.
                    </p>
                  </div>
                ) : products.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No products to display
                  </div>
                ) : (
                  <>
                    {statValues.length > 0 && (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleStatDragEnd}
                      >
                        <SortableContext
                          items={statValues.map((s) => s.key)}
                          strategy={rectSortingStrategy}
                        >
                          <div className="grid grid-cols-2 gap-3 mb-4">
                            {statValues.map((s) => (
                              <SortableStatCard key={s.key} id={s.key} label={s.label} value={s.value} />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}
                    <ProductsTable
                      initialProducts={computedProducts ?? products}
                      visibleColumns={selectedColumns}
                      initialFilterConfig={filterConfig}
                      onFilterConfigChange={setFilterConfig}
                      reportMode={true}
                      extraColumns={customColumns.map((cc) => ({
                        key: `__custom__${cc.id}`,
                        label: cc.name,
                        type: 'custom',
                        formula: cc.formula,
                      }))}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}