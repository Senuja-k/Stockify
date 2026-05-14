import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import { exportToExcel } from '../lib/exportToExcel';
import { applyFilters } from '../lib/filterEvaluation';
import { detectProductFields } from '../lib/columnDetection';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { AlertCircle, Eye, EyeOff, Lock, Download, RefreshCw } from 'lucide-react';
import { useToast } from '../components/ui/use-toast';
import { ProductsTable } from '../components/dashboard/ProductsTable';
import { Loader2 } from 'lucide-react';
import { SimpleHeader } from '../components/dashboard/SimpleHeader';
import { supabasePublic } from '../lib/supabase';
import { getReportByShareLink } from '../lib/supabase-utils';

/**
 * PUBLIC REPORT VIEWER
 * 
 * This implements Report Pundit-style shared link behavior:
 * 
 * MASTER REPORT (Read-Only):
 * - Stored in database with columns, filters, sorting, etc.
 * - Loaded once when viewer opens the shared link
 * - NEVER modified by viewer interactions
 * - Shared by all viewers of this link
 * 
 * VIEWER STATE (Session-Local):
 * - Each viewer can modify filters, sorting, column visibility
 * - These changes exist ONLY in this viewer's React state
 * - Changes are NEVER written to database
 * - Changes are NEVER visible to other viewers
 * - Changes reset when viewer refreshes or leaves the page
 * 
 * CONCURRENCY:
 * - Multiple users can view the same report simultaneously
 * - Each viewer's filter/sort changes are isolated
 * - No cross-user contamination or state collision
 * 
 * DATA FETCHING:
 * - Uses Report Pundit model: reads ONLY from Supabase (no Shopify API calls)
 * - Data is pre-synced by background jobs
 * - Fast parallel batch fetching
 * - AbortSignal for request cancellation
 */

// ============= TYPES =============

// ============= HELPER FUNCTIONS =============

/**
 * Check if an error is an AbortError (request cancellation).
 * AbortErrors are expected during component re-renders and should be ignored.
 * They should NOT trigger retries.
 */
function isAbortError(error) {
  if (!error) return false;
  const message = error?.message || String(error);
  return (
    error?.name === 'AbortError' ||
    message.includes('AbortError') ||
    message.includes('signal is aborted')
  );
}

/**
 * Fetch a single batch of products from Supabase.
 * Used by parallel fetching to get individual batches.
 */
async function fetchProductBatch(
  buildFilter,
  from,
  to,
  signal
) {
  const pageQuery = buildFilter(
    supabasePublic
      .from('shopify_products')
      .select('*')
      .range(from, to)
  ).abortSignal(signal);

  const { data, error } = await pageQuery;

  if (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error(error.message);
  }

  return data || [];
}

/**
 * Fetch products from Supabase for a public report.
 * 
 * Key principles (Report Pundit model):
 * - Only reads from Supabase (NEVER calls Shopify API)
 * - Uses AbortSignal for cancellation
 * - Does NOT retry on AbortError (only on real network/DB errors)
 * - PARALLEL batch fetching for speed (up to 5 concurrent requests)
 * - Fast because data is pre-synced in background
 */
async function fetchPublicReportProducts(
  storeId,
  organizationId,
  signal
) {
  // Determine filter criteria
  const isAllStores = storeId === 'all-stores' && organizationId;
  const isSingleStore = storeId && storeId !== 'all-stores';

  if (!isAllStores && !isSingleStore) {
    return { products: [], lastSyncAt: null };
  }

  // Build base filter - reusable for all queries
  const buildFilter = (query) => {
    if (isAllStores) {
      return query.eq('organization_id', organizationId);
    } else {
      let q = query.eq('store_id', storeId);
      if (organizationId) {
        q = q.eq('organization_id', organizationId);
      }
      return q;
    }
  };

  const startTime = performance.now();

  // Get count first - required for parallel fetching
  let totalCount = 0;
  try {
    const countQuery = buildFilter(
      supabasePublic
        .from('shopify_products')
        .select('id', { count: 'exact', head: true })
    ).abortSignal(signal);

    const { count, error: countError } = await countQuery;
    
    if (countError) {
      if (isAbortError(countError)) {
        throw countError;
      }
      console.warn('[fetchPublicReportProducts] Count query failed:', countError.message);
      // Fall back to sequential fetching if count fails
      totalCount = -1;
    } else {
      totalCount = count || 0;
      
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    totalCount = -1; // Fall back to sequential
  }

  // If we know there are 0 products, return early
  if (totalCount === 0) {
    return { products: [], lastSyncAt: null };
  }

  const batchSize = 1000;
  const maxConcurrent = 5; // Fetch up to 5 batches in parallel
  let allProducts = [];

  // PARALLEL FETCHING: If we know the count, fetch all batches in parallel
  if (totalCount > 0) {
    const totalBatches = Math.ceil(totalCount / batchSize);
    

    // Process batches in groups to limit concurrency
    for (let groupStart = 0; groupStart < totalBatches; groupStart += maxConcurrent) {
      if (signal.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const groupEnd = Math.min(groupStart + maxConcurrent, totalBatches);
      const batchPromises = [];

      for (let batchIndex = groupStart; batchIndex < groupEnd; batchIndex++) {
        const from = batchIndex * batchSize;
        const to = from + batchSize - 1;
        batchPromises.push(fetchProductBatch(buildFilter, from, to, signal));
      }

      // Fetch this group of batches in parallel
      const batchResults = await Promise.all(batchPromises);
      
      for (const batchProducts of batchResults) {
        if (batchProducts.length > 0) {
          allProducts.push(...batchProducts);
        }
      }

      
    }
  } else {
    // SEQUENTIAL FALLBACK: If count unknown, fetch sequentially until no more data
    
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const from = page * batchSize;
      const to = from + batchSize - 1;

      const batchProducts = await fetchProductBatch(buildFilter, from, to, signal);

      if (batchProducts.length > 0) {
        allProducts.push(...batchProducts);
      }

      hasMore = batchProducts.length === batchSize;
      page++;
    }
  }

  // Fetch last sync time in parallel with a small timeout (non-critical)
    let lastSyncAt = null;
  try {
    if (!signal.aborted) {
      const syncQuery = buildFilter(
        supabasePublic
          .from('shopify_store_sync_status')
          .select('last_synced_at')
      ).abortSignal(signal);

      const { data: syncStatuses } = await syncQuery;
      if (syncStatuses && syncStatuses.length > 0) {
        const syncTimes = syncStatuses
          .map((s) => s.last_synced_at)
          .filter(Boolean);
        if (syncTimes.length > 0) {
          lastSyncAt = syncTimes.sort().at(-1) || null;
        }
      }
    }
  } catch (syncError) {
    if (!isAbortError(syncError)) {
      console.warn('[fetchPublicReportProducts] Sync status fetch failed (non-critical):', syncError);
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  
  return { products: allProducts, lastSyncAt };
}

// ============= COMPONENT =============

export function PublicReport() {
  const { shareLink } = useParams();
  const { toast } = useToast();

  // Report metadata state (fetched from Supabase — works for ANY user/browser)
  const [reportData, setReportData] = useState(null);
  const report = reportData;
  const [reportLoading, setReportLoading] = useState(true);

  // Password authentication state
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  // Data fetch state (products from Supabase)
  const [fetchState, setFetchState] = useState({
    status: 'idle',
    error: null,
    products: [],
    lastSyncAt: null,
  });

  // UI state - VIEWER-SPECIFIC (not persisted, not shared across users)
  // Each viewer gets their own isolated React state for filters, sorting, etc.
  // Changes are NEVER written back to the master report or visible to other viewers.
  const [filterConfig, setFilterConfig] = useState({ items: [] });
  const [isExporting, setIsExporting] = useState(false);

  // Computed products from report's custom code (null = use raw fetchState.products)
  const [computedProducts, setComputedProducts] = useState(null);
  const [codeColumns, setCodeColumns] = useState([]);
  const [codeStats, setCodeStats] = useState([]);
  // Sales data fetched from shopify_sales table (populated during sync)
  const [publicSalesMap, setPublicSalesMap] = useState(new Map());

  // Compute stat values reactively from filtered products, respecting saved order
  const statValues = useMemo(() => {
    if (!codeStats.length) return [];
    const base = computedProducts ?? fetchState.products;
    const filtered = filterConfig?.items?.length ? applyFilters(base, filterConfig) : base;
    const mapped = codeStats.map((stat) => {
      try { return { key: stat.key, label: stat.label, value: stat.compute(filtered) }; }
      catch { return { key: stat.key, label: stat.label, value: '—' }; }
    });
    const savedOrder = report?.codeStatOrder;
    if (!Array.isArray(savedOrder) || !savedOrder.length) return mapped;
    return [...mapped].sort((a, b) => {
      const ai = savedOrder.indexOf(a.key);
      const bi = savedOrder.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [codeStats, computedProducts, fetchState.products, filterConfig, report?.codeStatOrder]);

  // AbortController ref for managing request cancellation
  const abortControllerRef = useRef(null);

  // ============= EFFECT: Load Report Metadata =============
  // Always fetches from Supabase using the public (anon) client so it works
  // for ANY user in ANY browser without needing to be logged in.
  useEffect(() => {
    if (!shareLink) {
      setReportLoading(false);
      return;
    }

    let cancelled = false;

    const loadReport = async () => {
      try {
        const supabaseReport = await getReportByShareLink(shareLink);
        if (cancelled) return;
        if (!supabaseReport) {
          console.warn(`[PublicReport] No report found for share link: ${shareLink}`);
        }
        setReportData(supabaseReport);
      } catch (error) {
        if (cancelled) return;
        console.error('[PublicReport] Failed to load report metadata:', error);
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    };

    loadReport();

    return () => { cancelled = true; };
  }, [shareLink]);

  // ============= EFFECT: Initialize Viewer Filters from Master Report =============
  // When the master report loads, initialize the viewer's filter state
  // This is the ONLY time we copy from master to viewer state
  // After this, viewer changes stay local and don't affect the master
  useEffect(() => {
    if (report?.filterConfig) {
      
      
      
      setFilterConfig(report.filterConfig);
    } else {
      
      setFilterConfig({ items: [] });
    }
  }, [report?.id]); // Only re-initialize when report ID changes (different report loaded)

  // ============= CALLBACK: Load Products =============
  // Fetches product data from Supabase (pre-synced).
  // No auto-sync logic — just reads what's already there.
  const loadProducts = useCallback(async () => {
    if (!report?.organizationId) {
      setFetchState(prev => ({
        ...prev,
        status: 'error',
        error: 'Report configuration is incomplete',
      }));
      return;
    }

    // Cancel any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create a fresh AbortController for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setFetchState(prev => ({ ...prev, status: 'loading', error: null }));

    try {
      // Fetch products from Supabase (pre-synced data)
      const result = await fetchPublicReportProducts(
        report.storeId,
        report.organizationId,
        controller.signal
      );

      // If aborted during fetch, exit silently
      if (controller.signal.aborted) {
        return;
      }

      // Format products for display
      const formattedProducts = (result.products || []).map((v) => {
        const productData = v.data || v;
        return {
          ...productData,
          id: v.id || v.shopify_product_id || productData.id,
          store_id: v.store_id,
          shopify_variant_id: v.shopify_variant_id,
          // Prefer top-level title; fall back to fullProduct for sync-stores format
          title: productData.title || productData.fullProduct?.title || '',
          // Prefer top-level status; fall back to fullProduct.status for sync-stores format
          status: productData.status || productData.fullProduct?.status || 'UNKNOWN',
          storeId: v.store_id,
          storeName: productData.storeName || '',
          // Hoist totalInventory so the popover check works
          totalInventory: productData.totalInventory ?? productData.fullProduct?.totalInventory,
          variantPrice: productData.variantPrice || productData.variantData?.price || productData.price,
          compareAtPrice: productData.compareAtPrice || productData.variantData?.compareAtPrice,
          sku: productData.sku || productData.variantData?.sku || undefined,
          barcode: productData.barcode || productData.variantData?.barcode || undefined,
          variantSku: productData.variantSku || productData.variantData?.sku || undefined,
          variantBarcode: productData.variantBarcode || productData.variantData?.barcode || undefined,
          variantTitle: productData.variantTitle || productData.variantData?.title || undefined,
          // Normalize image to a plain string URL regardless of sync format
          image: productData.image || productData.images?.edges?.[0]?.node?.url || null,
        };
      });

      // Merge per-location inventory from variant_inventory_locations
      try {
        const variantIds = formattedProducts.map((p) => p.shopify_variant_id).filter(Boolean);
        const storeIds = [...new Set(formattedProducts.map((p) => p.store_id).filter(Boolean))];
        if (variantIds.length > 0 && storeIds.length > 0) {
          const { data: locationRows } = await supabasePublic
            .from('variant_inventory_locations')
            .select('shopify_variant_id, store_id, locations')
            .in('shopify_variant_id', variantIds)
            .in('store_id', storeIds);
          if (locationRows?.length) {
            const locMap = {};
            for (const loc of locationRows) {
              locMap[`${loc.store_id}::${loc.shopify_variant_id}`] = loc.locations;
            }
            formattedProducts.forEach((p) => {
              p.locations = locMap[`${p.store_id}::${p.shopify_variant_id}`] ?? null;
            });
          }
        }
      } catch (_locErr) {
        // non-fatal — popover will lazy-fetch on open if needed
      }

      // Deduplicate by variant ID
      const seenVariantIds = new Set();
      const deduplicatedProducts = formattedProducts.filter((product) => {
        const variantKey = `${product.storeId}-${product.shopify_variant_id || product.id}`;
        if (seenVariantIds.has(variantKey)) {
          return false;
        }
        seenVariantIds.add(variantKey);
        return true;
      });

      setFetchState({
        status: 'success',
        error: null,
        products: deduplicatedProducts,
        lastSyncAt: result.lastSyncAt,
      });

      // Load persisted sales data from shopify_sales (best-effort, non-fatal)
      try {
        const storeIds = [...new Set(deduplicatedProducts.map((p) => p.store_id).filter(Boolean))];
        if (storeIds.length > 0) {
          const { data: salesRows } = await supabasePublic
            .from('shopify_sales')
            .select('sku, sales_qty, sales_amount')
            .in('store_id', storeIds);
          if (salesRows?.length) {
            const map = new Map();
            for (const row of salesRows) {
              const existing = map.get(row.sku);
              if (existing) {
                map.set(row.sku, {
                  qty: existing.qty + (row.sales_qty || 0),
                  amount: existing.amount + parseFloat(row.sales_amount || 0),
                });
              } else {
                map.set(row.sku, { qty: row.sales_qty || 0, amount: parseFloat(row.sales_amount || 0) });
              }
            }
            setPublicSalesMap(map);
          }
        }
      } catch (_salesErr) {
        // non-fatal — sales columns will show 0
      }

      // Auto-apply the report's custom code so computed columns show for this report
      const savedCode = (report?.customCode || '').trim();
      if (savedCode) {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(savedCode);
          const raw = fn();
          const columns = Array.isArray(raw) ? raw : (raw?.columns || []);
          const stats = Array.isArray(raw) ? [] : (raw?.stats || []);
          if (columns.every((c) => c.key && c.label && typeof c.compute === 'function')) {
            const enriched = deduplicatedProducts.map((row) => {
              const extra = {};
              for (const col of columns) {
                try { extra[col.key] = col.compute(row); } catch { extra[col.key] = ''; }
              }
              return { ...row, ...extra };
            });
            setCodeColumns(columns);
            setComputedProducts(enriched);
          }
          if (stats.every((s) => s.key && s.label && typeof s.compute === 'function')) {
            setCodeStats(stats);
          }
        } catch {
          // silently skip if code errors
        }
      }
    } catch (error) {
      // AbortErrors are expected during re-renders — handle silently
      if (isAbortError(error)) {
        return;
      }

      console.error('[PublicReport] Failed to load products:', error);
      setFetchState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to load report data',
      }));
    }
  }, [report?.storeId, report?.organizationId]);

  // ============= EFFECT: Trigger Product Load =============
  // Runs when user is authenticated and report is available
  useEffect(() => {
    if (!report || !isAuthenticated) {
      return;
    }

    loadProducts();

    // Cleanup: abort on unmount or when dependencies change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [report?.id, isAuthenticated, loadProducts]);

  // ============= HANDLERS =============

  const handlePasswordSubmit = () => {
    if (!report) return;

    setAuthLoading(true);
    // Small delay for UX
    setTimeout(() => {
      // Verify password locally against the report fetched from Supabase
      // Uses the same hash function as report creation
      const hashPassword = (pwd) => {
        let hash = 0;
        for (let i = 0; i < pwd.length; i++) {
          const char = pwd.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
      };

      if (hashPassword(password) === report.password) {
        setIsAuthenticated(true);
        toast({ title: 'Access granted' });
      } else {
        toast({
          title: 'Invalid Password',
          description: 'The password you entered is incorrect',
          variant: 'destructive',
        });
        setPassword('');
      }
      setAuthLoading(false);
    }, 300);
  };

  const handleExport = () => {
    if (!report || fetchState.products.length === 0) return;

    setIsExporting(true);
    try {
      // Use computedProducts when available — it has code-column values baked in.
      // Fall back to base fetchState.products if no custom code was applied.
      const baseProducts = computedProducts ?? fetchState.products;
      const filteredProducts = applyFilters(baseProducts, filterConfig);

      if (filteredProducts.length === 0) {
        toast({
          title: 'No products to export',
          description: 'No products match the current filters.',
          variant: 'destructive',
        });
        return;
      }

      // Build full column objects so exportToExcel gets labels and types.
      // Start with detected Shopify fields, then add any code columns.
      const detected = detectProductFields(filteredProducts);
      const detectedMap = new Map(detected.map((c) => [c.key, c]));

      // Map code columns (from savedCode) to exportable objects
      const codeColDefs = codeColumns.map((c) => ({
        key: c.key,
        label: c.label || c.key,
        type: 'string',
      }));
      codeColDefs.forEach((c) => detectedMap.set(c.key, c));

      // Determine which keys to export (from report's saved selection or all detected)
      const selectedKeys = Array.isArray(report?.selectedColumns) && report.selectedColumns.length > 0
        ? [
            ...report.selectedColumns,
            // also include any code columns not already in selectedColumns
            ...codeColDefs.filter((c) => !report.selectedColumns.includes(c.key)).map((c) => c.key),
          ]
        : [...detectedMap.keys()];

      // Resolve to full column objects (strings fall back to a basic definition)
      const columnsToExport = selectedKeys.map((k) => detectedMap.get(k) || { key: k, label: k, type: 'string' });

      const filename = `${report.name}-${new Date().toISOString().split('T')[0]}`;
      exportToExcel(filteredProducts, columnsToExport, filename, { salesMap: publicSalesMap });
      toast({
        title: 'Export successful',
        description: `Exported ${filteredProducts.length} products`,
      });
    } catch (error) {
      console.error('[PublicReport] Export error:', error);
      toast({
        title: 'Export failed',
        description: error?.message || 'Failed to export products',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleRetry = () => {
    // Manual retry - creates fresh request
    loadProducts();
  };

  // ============= RENDER: Loading report metadata =============
  if (reportLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ============= RENDER: Report not found =============
  if (!report) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-destructive">
          <CardContent className="pt-8">
            <div className="text-center">
              <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
              <h1 className="text-xl font-bold mb-2">Report Not Found</h1>
              <p className="text-muted-foreground">
                This report link is invalid or has been removed.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ============= RENDER: Password authentication =============
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              {report.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This report is password protected. Enter the password to view.
              </p>
              <div>
                <Label htmlFor="password">Password</Label>
                <div className="relative mt-2">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && !authLoading && handlePasswordSubmit()}
                    disabled={authLoading}
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <Button
                onClick={handlePasswordSubmit}
                className="w-full"
                disabled={!password.trim() || authLoading}
              >
                {authLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {authLoading ? 'Verifying...' : 'Access Report'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ============= RENDER: Authenticated report view =============
  return (
    <div className="min-h-screen bg-background">
      <SimpleHeader
        title={report.name}
        subtitle={report.storeName}
        showLogout={true}
        showWelcome={false}
        onSignOut={() => setIsAuthenticated(false)}
        // Refresh button removed for public reports
      />

      <div className="container mx-auto py-8 px-4">
        {/* Header with sync info and export button */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="text-sm text-muted-foreground">
              Last sync: {fetchState.lastSyncAt ? new Date(fetchState.lastSyncAt).toLocaleString() : '�'}
            </div>
            {/* Show filter count if filters are active */}
            {filterConfig.items && filterConfig.items.length > 0 && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 border-amber-500/20">
                  {filterConfig.items.length} filter{filterConfig.items.length !== 1 ? 's' : ''} active
                </Badge>
                {/* Clear filters button removed */}
              </div>
            )}
          </div>
          {fetchState.status === 'success' && fetchState.products.length > 0 && (
            <Button onClick={handleExport} disabled={isExporting} className="gap-2">
              {isExporting && <Loader2 className="h-4 w-4 animate-spin" />}
              <Download className="h-4 w-4" />
              {isExporting ? 'Exporting...' : 'Export to Excel'}
            </Button>
          )}
        </div>

        {/* Loading state */}
        {fetchState.status === 'loading' && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">Loading products...</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {fetchState.status === 'error' && (
          <div className="flex items-center justify-center py-12">
            <Card className="w-full max-w-md border-destructive">
              <CardContent className="pt-8">
                <div className="text-center">
                  <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">Failed to Load Report</h3>
                  <p className="text-muted-foreground text-sm mb-4">
                    {fetchState.error || 'An unexpected error occurred.'}
                  </p>
                  <Button onClick={handleRetry} variant="outline">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Try Again
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Success state: No products */}
        {fetchState.status === 'success' && fetchState.products.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center max-w-md">
              <AlertCircle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Products Found</h3>
              <p className="text-muted-foreground text-sm">
                There are no products available for this report.
              </p>
            </div>
          </div>
        )}

        {/* Success state: Products table */}
        {fetchState.status === 'success' && fetchState.products.length > 0 && (
          <>
            {statValues.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4 px-4">
                {statValues.map((s) => (
                  <div key={s.key} className="rounded-lg border bg-muted/40 px-4 py-3">
                    <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                    <p className="text-lg font-semibold leading-none">{s.value ?? '—'}</p>
                  </div>
                ))}
              </div>
            )}
            <ProductsTable
              initialProducts={computedProducts ?? fetchState.products}
              visibleColumns={[
                ...(report.selectedColumns || []),
                ...codeColumns.filter((c) => !(report.selectedColumns || []).includes(c.key)).map((c) => c.key),
              ]}
              reportMode={true}
              initialFilterConfig={filterConfig}
              onFilterConfigChange={setFilterConfig}
              salesMapOverride={publicSalesMap.size > 0 ? publicSalesMap : undefined}
              extraColumns={(report.customColumnDefs || []).map((cc) => ({
                key: cc.key,
                label: cc.name,
                type: 'custom',
                formula: cc.formula,
              }))}
            />
          </>
        )}
      </div>
    </div>
  );
}
