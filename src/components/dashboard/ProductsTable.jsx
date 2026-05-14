import { useState, useMemo, useEffect, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown, ArrowUp, ArrowDown, Code2, ChevronDown, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  detectProductFields,
  getNestedValue,
  formatColumnValue,
} from "@/lib/columnDetection";
import { useColumnPreferences } from "@/stores/columnPreferences";
import { ColumnSelector } from "./ColumnSelector";
import FilterBuilder from "./FilterBuilder.jsx";
import { applyFilters } from "@/lib/filterEvaluation";
import { useCustomColumnsStore } from "@/stores/customColumnsStore";
import { CustomColumnDialog } from "./CustomColumnDialog";
import { useOrganization } from "@/stores/organizationStore";
import { useSalesDataStore } from "@/stores/salesDataStore";
import { useStoreManagement } from "@/stores/storeManagement";
import { fetchInventoryLocations } from "@/lib/shopifyInventoryLocations";

// Sales column keys are computed from salesMap at render time, not stored on product objects.
// Used to separate sales conditions from DB-filterable conditions.
const SALES_COLUMN_KEYS = new Set(['__sales_qty__', '__sales_amount__']);

/**
 * Location inventory popover.
 * - If `locations` (pre-synced from DB) is provided: shows immediately, no API call.
 * - Otherwise falls back to lazy-fetch via shopify-admin-api proxy on first open.
 */
function LocationInventoryPopover({ totalValue, locations: preloadedLocations, variantId, storeConfig }) {
  const [open, setOpen] = useState(false);
  const [fetchedLocations, setFetchedLocations] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  // Use synced DB data if available; else use what we've lazy-fetched
  const locations = preloadedLocations ?? fetchedLocations;

  const handleOpenChange = async (nextOpen) => {
    setOpen(nextOpen);
    // Only lazy-fetch when we have no pre-loaded data and haven't fetched yet
    if (nextOpen && !preloadedLocations && fetchedLocations === null && !loading && variantId) {
      setLoading(true);
      setFetchError(null);
      try {
        const locs = await fetchInventoryLocations(storeConfig, variantId);
        setFetchedLocations(locs);
      } catch (e) {
        setFetchError(e.message);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors",
            (totalValue || 0) > 10 && "bg-success/10 text-success hover:bg-success/20",
            (totalValue || 0) <= 10 && (totalValue || 0) > 0 && "bg-warning/10 text-warning hover:bg-warning/20",
            (totalValue || 0) === 0 && "bg-muted/50 text-muted-foreground hover:bg-muted",
          )}
        >
          {totalValue || 0}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start" sideOffset={6}>
        <div className="px-3 py-2 border-b flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Locations</span>
        </div>
        {loading && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {fetchError && (
          <div className="px-3 py-3 text-xs text-destructive">{fetchError}</div>
        )}
        {!loading && !fetchError && locations && locations.length > 0 && (
          <>
            <ul className="py-1">
              {locations.map((loc, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-1.5 text-sm hover:bg-muted/40">
                  <span className="truncate text-foreground/80 max-w-[140px]">{loc.name}</span>
                  <span className={cn(
                    "ml-2 tabular-nums font-medium shrink-0",
                    loc.available > 10 && "text-success",
                    loc.available <= 10 && loc.available > 0 && "text-warning",
                    loc.available === 0 && "text-muted-foreground",
                  )}>
                    {loc.available}
                  </span>
                </li>
              ))}
            </ul>
            <div className="px-3 py-1.5 border-t flex items-center justify-between text-xs text-muted-foreground bg-muted/20">
              <span>Total available</span>
              <span className="font-medium">{locations.reduce((s, l) => s + l.available, 0)}</span>
            </div>
          </>
        )}
        {!loading && !fetchError && locations?.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted-foreground">No locations found</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * ProductsTable – supports two modes:
 *
 * 1. **Server-side** (default on Dashboard): parent provides `products`
 *    (one page), `totalCount`, pagination / sort / filter callbacks.
 * 2. **Client-side** (reports): pass `initialProducts` – the component
 *    handles filtering, sorting & pagination internally.
 */
function MobileProductList({ products, pageIndex, pageSize }) {
  return (
    <div className="space-y-3 p-2">
      {products.map((product, idx) => {
        const key = product.id || product.shopify_product_id || idx;
        const price = String(
          getNestedValue(product, "variantPrice") || getNestedValue(product, "price") || "—",
        );
        return (
          <div key={key} className="bg-card border rounded p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{product.title || product.name || 'Untitled'}</div>
                <div className="text-xs text-muted-foreground truncate">{product.handle || product.shopify_handle || ''}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="outline" className="text-xs">{product.vendor || 'N/A'}</Badge>
                  {product.productType && (
                    <Badge variant="outline" className="text-xs">{product.productType}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">SKU: {product.sku || (product.variantData && product.variantData.sku) || '—'}</span>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-medium">{price}</div>
                <div className="text-xs text-muted-foreground">{product.storeName || ''}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProductsTable({
  // --- Server-side mode props (from Index.jsx) ---
  products: pageProducts,
  totalCount: externalTotalCount,
  isLoadingPage = false,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  onFilterApply,
  pageIndex: externalPageIndex,
  pageSize: externalPageSize,
  sortField: externalSortField,
  sortDirection: externalSortDirection,
  appliedFilterConfig,

  // --- Client-side mode props (from report pages) ---
  initialProducts,
  initialFilterConfig,
  onFilterConfigChange,

  // --- Shared props ---
  onColumnsChange,
  showStoreColumn = false,
  visibleColumns,
  reportMode = false,
  extraColumns: extraColumnsProp = [],
  salesMapOverride,
}) {
  // Detect mode: if initialProducts is supplied, use client-side mode
  const isClientSide = !!initialProducts;

  // ---------- Client-side internal state ----------
  const [csPageIndex, setCsPageIndex] = useState(0);
  const [csPageSize, setCsPageSize] = useState(25);
  const [csSortField, setCsSortField] = useState(null);
  const [csSortDirection, setCsSortDirection] = useState(null);
  const [csFilterConfig, setCsFilterConfig] = useState(
    initialFilterConfig || { items: [] },
  );

  // Unified accessors
  const pageIndex = isClientSide ? csPageIndex : (externalPageIndex ?? 0);
  const pageSize = isClientSide ? csPageSize : (externalPageSize ?? 25);
  const sortField = isClientSide ? csSortField : externalSortField;
  const sortDirection = isClientSide ? csSortDirection : externalSortDirection;
  const filterConfig = isClientSide
    ? csFilterConfig
    : appliedFilterConfig || { items: [] };

  // Sales data — brought in early so csFiltered can use salesMap for Sales Qty/Amount conditions
  const { salesMap: storeSalesMap, isLoading: salesLoading, error: salesError } = useSalesDataStore();
  const salesMap = salesMapOverride ?? storeSalesMap;

  // Client-side: apply filters → sort → paginate
  const csAllProducts = initialProducts || [];

  const csFiltered = useMemo(() => {
    if (!isClientSide) return [];
    // Enrich each product with its computed sales values so filter conditions on
    // __sales_qty__ / __sales_amount__ evaluate correctly (those fields don't exist
    // on the raw product objects — they are looked up from salesMap at render time).
    const enriched = csAllProducts.map((p) => {
      const sku = p.sku || p.variantSku;
      const entry = sku ? salesMap.get(sku) : null;
      return { ...p, __sales_qty__: entry?.qty ?? 0, __sales_amount__: entry?.amount ?? 0 };
    });
    return applyFilters(enriched, csFilterConfig);
  }, [isClientSide, csAllProducts, csFilterConfig, salesMap]);

  const csSorted = useMemo(() => {
    if (!isClientSide || !csSortField) return csFiltered;
    return [...csFiltered].sort((a, b) => {
      const aVal = getNestedValue(a, csSortField);
      const bVal = getNestedValue(b, csSortField);
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      let cmp = 0;
      if (typeof aVal === "string")
        cmp = aVal.toLowerCase().localeCompare(String(bVal).toLowerCase());
      else cmp = Number(aVal) - Number(bVal);
      return csSortDirection === "desc" ? -cmp : cmp;
    });
  }, [isClientSide, csFiltered, csSortField, csSortDirection]);

  const csTotalCount = isClientSide ? csSorted.length : 0;

  const csPageProducts = useMemo(() => {
    if (!isClientSide) return [];
    const start = csPageIndex * csPageSize;
    return csSorted.slice(start, start + csPageSize);
  }, [isClientSide, csSorted, csPageIndex, csPageSize]);

  // The products to render + total count
  const products = isClientSide ? csPageProducts : pageProducts || [];
  const totalCount = isClientSide ? csTotalCount : (externalTotalCount ?? 0);

  // Server-side post-filter for sales columns: the DB query can't filter __sales_qty__ /
  // __sales_amount__ (they're not in the JSONB data column). We strip them from the server
  // query (see serverQueries.js) and re-apply them here after the page results arrive.
  const salesPostFilter = useMemo(() => {
    if (isClientSide) return null;
    const config = appliedFilterConfig || { items: [] };
    const salesItems = config.items.filter(
      (item) => typeof item === 'object' && item && 'id' in item && SALES_COLUMN_KEYS.has(item.field),
    );
    return salesItems.length > 0 ? { items: salesItems } : null;
  }, [isClientSide, appliedFilterConfig]);

  const displayProducts = useMemo(() => {
    if (isClientSide || !salesPostFilter) return products;
    const enriched = products.map((p) => {
      const sku = p.sku || p.variantSku;
      const entry = sku ? salesMap.get(sku) : null;
      return { ...p, __sales_qty__: entry?.qty ?? 0, __sales_amount__: entry?.amount ?? 0 };
    });
    return applyFilters(enriched, salesPostFilter);
  }, [isClientSide, products, salesPostFilter, salesMap]);
  // Column resizing state
  const [columnWidths, setColumnWidths] = useState({});
  const resizingColumnRef = useRef(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Column resize handlers
  const handleResizeStart = (columnKey, e) => {
    e.preventDefault();
    e.stopPropagation();
    resizingColumnRef.current = columnKey;
    startXRef.current = e.clientX;
    const headerElement = e.target.closest("th");
    startWidthRef.current = headerElement?.offsetWidth || 150;
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  };

  const handleResizeMove = (e) => {
    if (!resizingColumnRef.current) return;
    const diff = e.clientX - startXRef.current;
    const newWidth = Math.max(80, startWidthRef.current + diff);
    setColumnWidths((prev) => ({
      ...prev,
      [resizingColumnRef.current]: newWidth,
    }));
  };

  const handleResizeEnd = () => {
    resizingColumnRef.current = null;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  };

  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleResizeMove);
      document.removeEventListener("mouseup", handleResizeEnd);
    };
  }, []);

  const { preferences, initializePreferences, loadPreferences } = useColumnPreferences();

  // Load column preferences from the database once on mount
  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  const { customColumns, loadCustomColumns } = useCustomColumnsStore();
  const { activeOrganizationId } = useOrganization();
  const { stores } = useStoreManagement();
  const [showCustomColumnDialog, setShowCustomColumnDialog] = useState(false);

  // Load persisted custom columns whenever the active org changes
  useEffect(() => {
    if (!reportMode) {
      loadCustomColumns(activeOrganizationId);
    }
  }, [activeOrganizationId, reportMode, loadCustomColumns]);

  // Detect columns – in client-side mode use full dataset, else current page
  const columnSource = isClientSide ? csAllProducts : products;
  const allColumns = useMemo(() => {
    // detectProductFields is fully data-driven — returns all fields present in products.
    // When products is empty the list is empty; sales + custom cols are always appended.
    const detected = detectProductFields(columnSource);
    if (showStoreColumn && !detected.some((c) => c.key === "storeName")) {
      detected.push({
        key: "storeName",
        label: "Store",
        type: "string",
        sortable: true,
        filterable: true,
      });
    }
    // detected columns never have hidden:true in the new system; filter kept for safety
    const base = detected.filter((col) => !col.hidden);
    const salesCols = [
      { key: '__sales_qty__', label: 'Sales Qty', type: 'sales_qty', sortable: false, filterable: false },
      { key: '__sales_amount__', label: 'Sales Amount', type: 'sales_amount', sortable: false, filterable: false },
    ];
    if (reportMode) {
      // Always include sales cols in allColumns — the columns useMemo filters by visibleColumns.
      // Custom formula columns are supplied via extraColumnsProp in reportMode.
      return [...base, ...salesCols];
    }
    const customCols = customColumns.map((cc) => ({
      key: `__custom__${cc.id}`,
      label: cc.name,
      type: 'custom',
      formula: cc.formula,
      sortable: false,
      filterable: false,
    }));
    return [...base, ...salesCols, ...customCols];
  }, [columnSource, showStoreColumn, reportMode, customColumns]);

  useEffect(() => {
    if (allColumns.length > 0) initializePreferences(allColumns);
  }, [allColumns, initializePreferences]);

  // Stable column list for FilterBuilder — only grows, never shrinks.
  // When the current page returns 0 results, detectProductFields() falls back to
  // a minimal default set, which would cause existing filter field dropdowns to go
  // blank because their stored key is no longer in availableColumns.  We keep the
  // largest column set we've ever seen so the filter UI stays consistent.
  const [stableFilterColumns, setStableFilterColumns] = useState([]);
  useEffect(() => {
    if (allColumns.length === 0) return;
    setStableFilterColumns((prev) => {
      const prevKeys = new Set(prev.map((c) => c.key));
      const added = allColumns.filter((c) => !prevKeys.has(c.key));
      if (added.length === 0) return prev;
      return [...prev, ...added];
    });
  }, [allColumns]);
  const filterColumns = stableFilterColumns.length > 0 ? stableFilterColumns : allColumns;

  // Visible / ordered columns
  const columns = useMemo(() => {
    const prefMap = preferences instanceof Map ? preferences : new Map();
    return allColumns
      .filter((col) => {
        if (reportMode && visibleColumns)
          return visibleColumns.includes(col.key);
        const pref = prefMap.get(col.key);
        return pref?.visible ?? true;
      })
      .sort((a, b) => {
        if (reportMode && visibleColumns)
          return visibleColumns.indexOf(a.key) - visibleColumns.indexOf(b.key);
        const prefA = prefMap.get(a.key);
        const prefB = prefMap.get(b.key);
        return (prefA?.order ?? Infinity) - (prefB?.order ?? Infinity);
      });
  }, [allColumns, preferences, reportMode, visibleColumns]);

  // Append user-defined custom columns + built-in sales columns (never shown in reportMode)
  const finalColumns = useMemo(() => {
    if (reportMode) {
      // In report mode, append any extraColumns (e.g. custom columns from EditReport)
      const extraKeys = new Set(extraColumnsProp.map((c) => c.key));
      const extra = extraColumnsProp
        .filter((c) => !visibleColumns || visibleColumns.includes(c.key))
        .map((c) => ({ ...c, sortable: false, filterable: false }));
      return [...columns.filter((c) => !extraKeys.has(c.key)), ...extra];
    }
    // In normal mode, sales and custom cols are already part of allColumns → columns
    return columns;
  }, [columns, reportMode, extraColumnsProp, visibleColumns]);

  useEffect(() => {
    onColumnsChange?.(finalColumns);
  }, [finalColumns, onColumnsChange]);

  // Pagination derived values
  const pageCount = Math.ceil(totalCount / pageSize);

  // Sort handler – delegates to parent or updates local state
  const handleSort = (field) => {
    let newField = field;
    let newDir = "asc";

    if (sortField === field) {
      if (sortDirection === "asc") {
        newDir = "desc";
      } else {
        newField = null;
        newDir = null;
      }
    }
    if (isClientSide) {
      setCsSortField(newField);
      setCsSortDirection(newDir);
      setCsPageIndex(0);
    } else {
      onSortChange?.(newField, newDir);
    }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field)
      return (
        <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-muted-foreground/50" />
      );
    if (sortDirection === "asc")
      return <ArrowUp className="ml-1 h-3.5 w-3.5 text-primary" />;
    return <ArrowDown className="ml-1 h-3.5 w-3.5 text-primary" />;
  };

  const activeFilterCount = (filterConfig?.items ?? []).filter(
    (item) => typeof item === "object" && "id" in item,
  ).length;

  // Mobile detection for compact list rendering
  const [isMobile, setIsMobile] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.innerWidth < 640;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Safely evaluate a custom column formula against a product row.
  // Formula may return a plain value OR { value, color } for colored cells.
  // color can be any CSS color string e.g. 'red', '#22c55e', 'rgb(...)'
  const evaluateFormula = (formula, row) => {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('row', `"use strict"; return (${formula})`);
      const result = fn(row);
      if (result !== null && result !== undefined && typeof result === 'object' && 'value' in result) {
        return { value: result.value !== null && result.value !== undefined ? String(result.value) : '—', color: result.color || null };
      }
      return { value: result !== null && result !== undefined ? String(result) : '—', color: null };
    } catch {
      return { value: '⚠ Error', color: null };
    }
  };

  // Cell renderer
  const renderCellContent = (product, column) => {
    if (column.type === 'custom') {
      const { value: cellValue, color: cellColor } = evaluateFormula(column.formula, product);
      if (cellColor) {
        return (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: cellColor + '22', color: cellColor, border: `1px solid ${cellColor}44` }}
          >
            {cellValue}
          </span>
        );
      }
      return (
        <span className="text-sm text-foreground/85">{cellValue}</span>
      );
    }

    if (column.type === 'sales_qty' || column.type === 'sales_amount') {
      const sku = product.sku || product.variantSku;
      if (salesLoading) {
        return <span className="text-xs text-muted-foreground">...</span>;
      }
      if (!sku) {
        return <span className="text-xs text-muted-foreground">—</span>;
      }
      const entry = salesMap.get(sku);
      // If no entry and there was a fetch error, show N/A (plan restriction or scope issue)
      if (!entry && salesError && salesMap.size === 0) {
        return <span className="text-xs text-muted-foreground" title={`Sales data unavailable: ${salesError}`}>N/A</span>;
      }
      if (column.type === 'sales_qty') {
        return <span className="text-sm">{entry ? entry.qty.toLocaleString() : '0'}</span>;
      }
      return (
        <span className="text-sm">
          {entry ? entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
        </span>
      );
    }

    const value = getNestedValue(product, column.key);

    if (column.key === "image" || column.key === "images" || column.type === "image") {
      const imgUrl = product.image || product.images?.edges?.[0]?.node?.url;
      return (
        <div className="w-10 h-10 rounded-md overflow-hidden bg-muted flex items-center justify-center">
          {imgUrl ? (
            <img
              src={imgUrl}
              alt={product.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-xs text-muted-foreground">N/A</span>
          )}
        </div>
      );
    }

    if (column.key === "title") {
      return (
        <div className="space-y-0.5">
          <p className="font-medium truncate max-w-[250px]">{product.title}</p>
          <p className="text-xs text-muted-foreground truncate max-w-[250px]">
            {product.handle}
          </p>
        </div>
      );
    }

    if (column.type === "currency")
      return formatColumnValue(
        value,
        "currency",
        product.currencyCode || product.priceRange?.minVariantPrice?.currencyCode,
      );
    if (column.type === "number") {
      if (column.key === "totalInventory" || column.key.endsWith(".totalInventory")) {
        const syncedLocations = product.locations;
        const variantId = product.shopify_variant_id;
        const storeConfig = stores?.find((s) => s.id === product.store_id);
        // Show popover whenever we have synced location data OR a variantId to lazy-fetch with.
        // Missing adminToken is handled gracefully inside the popover itself.
        const canShowPopover =
          (Array.isArray(syncedLocations) && syncedLocations.length > 0) ||
          !!variantId;
        if (canShowPopover) {
          return (
            <LocationInventoryPopover
              totalValue={value}
              locations={syncedLocations ?? null}
              variantId={variantId}
              storeConfig={storeConfig}
            />
          );
        }
        return (
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
              (value || 0) > 10 && "bg-success/10 text-success",
              (value || 0) <= 10 &&
                (value || 0) > 0 &&
                "bg-warning/10 text-warning",
              (value || 0) === 0 && "bg-muted/50 text-muted-foreground",
            )}
          >
            {value || 0}
          </span>
        );
      }
      return formatColumnValue(value, "number");
    }
    if (column.type === "date") return formatColumnValue(value, "date");
    if (column.type === "string") {
      if (["vendor", "productType", "storeName"].includes(column.key)) {
        return (
          <Badge variant="outline" className="font-normal">
            {value || "N/A"}
          </Badge>
        );
      }
      return value ? (
        <span className="text-sm text-foreground/85">{value}</span>
      ) : (
        "N/A"
      );
    }
    return formatColumnValue(value, column.type);
  };

  return (
    <div className="space-y-4">
      {/* Custom Column Dialog */}
      {!reportMode && (
        <CustomColumnDialog
          open={showCustomColumnDialog}
          onOpenChange={setShowCustomColumnDialog}
          organizationId={activeOrganizationId}
          sampleRow={displayProducts[0] || null}
        />
      )}

      {/* Toolbar */}
      <div className="glass-card rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-center">
          {!reportMode && <ColumnSelector availableColumns={allColumns} />}

          {!reportMode && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCustomColumnDialog(true)}
              className="gap-2"
            >
              <Code2 className="h-4 w-4" />
              Custom Columns
              {customColumns.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {customColumns.length}
                </Badge>
              )}
            </Button>
          )}

          {/* Page size */}
          <div className="ml-auto">
            <Select
              value={pageSize.toString()}
              disabled={!isClientSide && !onPageSizeChange}
              onValueChange={(v) => {
                const newSize = parseInt(v);
                if (isClientSide) {
                  setCsPageSize(newSize);
                  setCsPageIndex(0);
                } else {
                  onPageSizeChange?.(newSize);
                }
              }}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Items per page" />
              </SelectTrigger>
              <SelectContent>
                  <SelectItem value="25">25 per page</SelectItem>
                  {(isClientSide || onPageSizeChange) && (
                    <>
                      <SelectItem value="50">50 per page</SelectItem>
                      <SelectItem value="100">100 per page</SelectItem>
                    </>
                  )}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Filter builder (always visible) */}
        <div className="mt-4 p-4 border rounded-lg bg-muted/50">
          <FilterBuilder
            config={filterConfig}
            onApply={(config) => {
              if (isClientSide) {
                setCsFilterConfig(config);
                setCsPageIndex(0);
                onFilterConfigChange?.(config);
              } else {
                onFilterApply?.(config);
              }
            }}
            availableColumns={filterColumns}
          />
        </div>
      </div>

      {/* Table / Mobile list */}
      <div className="glass-card rounded-lg overflow-hidden relative">
        <div className="overflow-x-auto">
          
            <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="w-[50px]">#</TableHead>
                {finalColumns.map((column) => (
                  <TableHead
                    key={column.key}
                    className={cn(
                      column.type === "number" && "text-right",
                      column.type === "currency" && "text-right",
                      "relative group",
                    )}
                    style={{
                      width: columnWidths[column.key]
                        ? `${columnWidths[column.key]}px`
                        : undefined,
                      minWidth: columnWidths[column.key]
                        ? `${columnWidths[column.key]}px`
                        : undefined,
                    }}
                  >
                    {column.sortable ? (
                      <button
                        onClick={() => handleSort(column.key)}
                        className="flex items-center font-medium hover:text-foreground transition-colors w-full"
                      >
                        {column.label} <SortIcon field={column.key} />
                      </button>
                    ) : (
                      <span className="font-medium">{column.label}</span>
                    )}
                    <div
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      onMouseDown={(e) => handleResizeStart(column.key, e)}
                      style={{ userSelect: "none" }}
                    >
                      <div className="w-0.5 h-4 bg-primary/70" />
                    </div>
                  </TableHead>
                ))}
                {showStoreColumn &&
                  !finalColumns.some((c) => c.key === "storeName") && (
                    <TableHead className="relative group">
                      <button
                        onClick={() => handleSort("storeName")}
                        className="flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        Store <SortIcon field="storeName" />
                      </button>
                      <div
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                        onMouseDown={(e) => handleResizeStart("storeName", e)}
                        style={{ userSelect: "none" }}
                      >
                        <div className="w-0.5 h-4 bg-primary/70" />
                      </div>
                    </TableHead>
                  )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayProducts.length === 0 && !isLoadingPage ? (
                <TableRow>
                  <TableCell
                    colSpan={finalColumns.length + 1}
                    className="text-center py-12 text-muted-foreground"
                  >
                    No products found matching your filters
                  </TableCell>
                </TableRow>
              ) : (
                displayProducts.map((product, index) => {
                  const variantId = product.variantId;
                  const productKey = variantId
                    ? `${product.id}-${variantId}-${index}`
                    : `${product.id}-${index}`;
                  return (
                    <TableRow
                      key={productKey}
                      className="hover:bg-muted/20 transition-colors"
                    >
                      <TableCell className="text-foreground/70 text-sm font-medium">
                        {pageIndex * pageSize + index + 1}
                      </TableCell>
                      {finalColumns.map((column) => (
                        <TableCell
                          key={`${productKey}-${column.key}`}
                          className={cn(
                            column.type === "number" && "text-right",
                            column.type === "currency" && "text-right",
                            "overflow-hidden",
                          )}
                          style={{
                            width: columnWidths[column.key]
                              ? `${columnWidths[column.key]}px`
                              : undefined,
                            minWidth: columnWidths[column.key]
                              ? `${columnWidths[column.key]}px`
                              : undefined,
                            maxWidth: columnWidths[column.key]
                              ? `${columnWidths[column.key]}px`
                              : undefined,
                            maxHeight: "60px",
                          }}
                        >
                          <div
                            className="truncate max-h-[60px] overflow-hidden"
                            title={String(
                              getNestedValue(product, column.key) || "",
                            )}
                          >
                            {renderCellContent(product, column)}
                          </div>
                        </TableCell>
                      ))}
                      {showStoreColumn &&
                        !finalColumns.some((c) => c.key === "storeName") && (
                          <TableCell>
                            <Badge variant="secondary" className="font-normal">
                              {product.storeName}
                            </Badge>
                          </TableCell>
                        )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="glass-card rounded-lg p-4">
        <div className="flex items-center justify-between text-sm">
          <div className="text-muted-foreground">
            Showing{" "}
            <span className="font-medium text-foreground">
              {products.length > 0 ? pageIndex * pageSize + 1 : 0}–
              {pageIndex * pageSize + products.length}
            </span>{" "}
            of <span className="font-medium text-foreground">{totalCount}</span>{" "}
            products
          </div>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isClientSide) setCsPageIndex(pageIndex - 1);
                  else onPageChange?.(pageIndex - 1);
                }}
                disabled={pageIndex === 0 || isLoadingPage}
              >
                Previous
              </Button>
              <span className="text-sm font-medium text-muted-foreground">
                Page {pageIndex + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isClientSide) setCsPageIndex(pageIndex + 1);
                  else onPageChange?.(pageIndex + 1);
                }}
                disabled={pageIndex >= pageCount - 1 || isLoadingPage}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
