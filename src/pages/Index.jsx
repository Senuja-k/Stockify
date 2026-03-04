import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useProductsStore } from "@/stores/productsStore";
import { Package, Banknote, Building2, Tags, Store } from "lucide-react";
import { exportToExcel } from "@/lib/exportToExcel";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { StatsCard } from "@/components/dashboard/StatsCard";
import { ProductsTable } from "@/components/dashboard/ProductsTable";
import { AddStoreDialog } from "@/components/dashboard/AddStoreDialog";
import { StoreSelector } from "@/components/dashboard/StoreSelector";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { useStoreManagement } from "@/stores/storeManagement";
import {
  queryProductsPage,
  queryAllFilteredProducts,
  queryProductStats,
} from "@/lib/serverQueries";
import { refreshSessionSilently, ensureValidSession } from "@/lib/supabase";
import { syncStoresProductsFull, getOrgLastSyncTime } from "@/lib/shopifySync";
import { useOrganization } from "@/stores/organizationStore";
import { useAuth } from "@/stores/authStore.jsx";
import { useLocation } from "react-router-dom";
import { useProductsPageCacheStore } from "@/stores/productsPageCacheStore";

// Helper function to check if an error is an AbortError
function isAbortError(error) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  )
    return true;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    (error.message.toLowerCase().includes("abort") ||
      error.message.includes("cancelled"))
  )
    return true;
  return false;
}

function isAuthError(error) {
  const text = String(
    error?.message || error?.details || error?.hint || "",
  ).toLowerCase();
  return (
    text.includes("jwt") ||
    text.includes("token") ||
    text.includes("auth") ||
    text.includes("permission") ||
    text.includes("unauthorized") ||
    text.includes("forbidden")
  );
}

const DASHBOARD_VIEW_STATE_KEY = "dashboard-view-state";

function readDashboardViewState() {
  try {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(DASHBOARD_VIEW_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeDashboardViewState(state) {
  try {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(DASHBOARD_VIEW_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function Index() {
  const savedViewRef = useRef(readDashboardViewState());

  // --- Column / export state ---
  const [selectedColumns, setSelectedColumns] = useState([]);
  const [isExporting, setIsExporting] = useState(false);

  // --- Server-side pagination / sort / filter state ---
  const [pageIndex, setPageIndex] = useState(() => {
    const v = savedViewRef.current?.pageIndex;
    return Number.isInteger(v) && v >= 0 ? v : 0;
  });
  const [pageSize, setPageSize] = useState(() => {
    const v = savedViewRef.current?.pageSize;
    return Number.isInteger(v) && v > 0 ? v : 25;
  });
  const [sortField, setSortField] = useState(
    () => savedViewRef.current?.sortField ?? null,
  );
  const [sortDirection, setSortDirection] = useState(
    () => savedViewRef.current?.sortDirection ?? null,
  );
  const [appliedFilterConfig, setAppliedFilterConfig] = useState(() => {
    const cfg = savedViewRef.current?.appliedFilterConfig;
    if (cfg && typeof cfg === "object" && Array.isArray(cfg.items)) return cfg;
    return { items: [] };
  });

  // --- Data state ---
  const [pageProducts, setPageProducts] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState({
    totalProducts: 0,
    totalStores: 0,
    totalVendors: 0,
    totalTypes: 0,
    avgPrice: 0,
  });

  // --- Loading state ---
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [error, setError] = useState(null);

  // Sync metadata (persisted)
  const lastSyncAt = useProductsStore((state) => state.lastSyncAt);
  const setLastSyncAt = useProductsStore((state) => state.setLastSyncAt);

  // ✅ NEW: background sync indicator for header
  const [isSyncing, setIsSyncing] = useState(false);

  // Refs
  const abortControllerRef = useRef(null);
  const syncCheckRef = useRef(null);
  const lastRouteEnterRef = useRef(Date.now());
  const pageAbortRef = useRef(null);
  const statsAbortRef = useRef(null);
  const pageReqIdRef = useRef(0);
  const pageIndexRef = useRef(0);
  const isSyncingRef = useRef(false);
  const lastNonEmptyStoreIdsRef = useRef([]);
  const lastNonEmptyStoresRef = useRef([]);
  const initializedContextRef = useRef("");
  const pageLoadingStartedAtRef = useRef(0);
  const wasHiddenRef = useRef(false);

  // ✅ NEW: prevent double refresh spam on tab return
  const returnDebounceRef = useRef(0);
  const tabRefreshInFlightRef = useRef(false);
  const hasTriggeredHomeReloadRef = useRef(false);
  const lastPathRef = useRef("");

  // ✅ NEW: freshness tracking to avoid unnecessary work
  const lastDataFetchAtRef = useRef(0);
  const lastStatsFetchAtRef = useRef(0);
  const DATA_STALE_MS = 2 * 60 * 1000;
  const STATS_STALE_MS = 60 * 1000; // 60s
  const PAGE_REQUEST_TIMEOUT_MS = 20000;

  const location = useLocation();

  const {
    stores,
    selectedStoreId,
    viewMode,
    isLoading: isLoadingStores,
    error: storesError, // optional
  } = useStoreManagement();

  const activeOrganizationId = useOrganization(
    (state) => state.activeOrganizationId,
  );
  const {
    user,
    isAuthenticated,
    isLoading: isAuthLoading,
    isInitialized: isAuthInitialized,
  } = useAuth();
  const userId = user?.id || null;
  const canExport = !!(isAuthenticated && isAuthInitialized && !isAuthLoading);
  console.log('[Index] render auth state', { isAuthenticated, isAuthInitialized, isAuthLoading, canExport });

  // Cache store (instant restore after reload/back)
  const cache = useProductsPageCacheStore();

  // If the app was backgrounded while on a different route, soft-recover
  // (refresh session + refetch data) instead of a full page reload.
  useEffect(() => {
    try {
      const wasHidden = sessionStorage.getItem("app-was-hidden");
      if (wasHidden) {
        sessionStorage.removeItem("app-was-hidden");
        sessionStorage.removeItem("app-last-hidden-at");
        // Soft recovery: refresh session then refetch
        ensureValidSession(8000, true).then(() => {
          fetchPageRef.current?.({
            page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
            showPageLoader: false,
            includeCount: true,
          });
        }).catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  }, []);

  // If Index unmounts while on the home page, mark a pending reload so
  // when the user navigates back (and Index remounts) we can force a reload.
  useEffect(() => {
    try {
      // cleanup runs on unmount — capture current path
      return () => {
        try {
          if (location && location.pathname === "/") {
            sessionStorage.setItem("home-reload-pending", "1");
            console.log('[Index] marking home-reload-pending on unmount');
          }
        } catch (e) {
          // ignore
        }
      };
    } catch (e) {
      // ignore
    }
    // Depend on location.pathname so the cleanup knows the current route
  }, [location.pathname]);

  // On mount (or when location changes), if a pending reload was set while
  // Index was unmounted, trigger a soft recovery (session refresh + refetch).
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("home-reload-pending") === "1";
      if (pending) {
          sessionStorage.removeItem("home-reload-pending");
          console.log('[Index] home-reload-pending detected on mount — soft recovery');
          if (location && location.pathname === "/") {
            ensureValidSession(10000, true).then(() => {
              fetchPageRef.current?.({
                page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
                showPageLoader: false,
                includeCount: true,
              });
            }).catch(() => {});
          }
        }
    } catch (e) {
      // ignore
    }
  }, [location.pathname]);

  // When returning to the home page after leaving it, soft-recover
  // by refreshing the session and refetching data (not a full page reload).
  useEffect(() => {
    const prevPath = lastPathRef.current;
    const nextPath = location.pathname;
    console.log('[Index] route-change detected', { prevPath, nextPath });
    // Update lastPathRef for next navigation
    lastPathRef.current = nextPath;

    // If this is the initial mount, prevPath will be falsy — skip.
    if (!prevPath) return;

    // If we navigated into home from a different path, soft-recover.
    if (nextPath === '/' && prevPath !== '/' && !hasTriggeredHomeReloadRef.current) {
      hasTriggeredHomeReloadRef.current = true;
      console.log('[Index] navigated into home — refreshing session and refetching data');
      ensureValidSession(10000, true).then(() => {
        fetchPageRef.current?.({
          page: typeof pageIndexRef.current === 'number' ? pageIndexRef.current : 0,
          showPageLoader: false,
          includeCount: true,
        });
      }).catch((e) => {
        console.warn('[Index] soft recovery after route change failed:', e);
      });
    }
  }, [location.pathname]);

  // Suppress noisy AbortError unhandled rejections during reloads.
  useEffect(() => {
    const onUnhandledRejection = (event) => {
      if (isAbortError(event?.reason)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  // Stores to query
  const storesToFetch = useMemo(() => {
    if (viewMode === "combined" && selectedStoreId === null) return stores;
    if (selectedStoreId) {
      const store = stores.find((s) => s.id === selectedStoreId);
      return store ? [store] : [];
    }
    return stores;
  }, [stores, selectedStoreId, viewMode]);

  const storeIds = useMemo(
    () => storesToFetch.map((s) => s.id),
    [storesToFetch],
  );
  const storesKey = useMemo(() => [...storeIds].sort().join(","), [storeIds]);
  useEffect(() => {
    if (storeIds.length > 0) {
      lastNonEmptyStoreIdsRef.current = storeIds;
      lastNonEmptyStoresRef.current = storesToFetch;
    }
  }, [storeIds, storesToFetch]);

  // Cache key for instant restore
  const currentCacheKey = useMemo(() => {
    return JSON.stringify({
      org: activeOrganizationId || null,
      storeIds: [...storeIds].sort(),
      filter: appliedFilterConfig,
      sortField,
      sortDirection,
      pageIndex,
      pageSize,
    });
  }, [
    activeOrganizationId,
    storeIds,
    appliedFilterConfig,
    sortField,
    sortDirection,
    pageIndex,
    pageSize,
  ]);

  // ✅ Instant paint from cache on reload/back
  useEffect(() => {
    if (cache.cacheKey === currentCacheKey && cache.pageProducts?.length > 0) {
      setPageProducts(cache.pageProducts);
      setTotalCount(cache.totalCount || 0);
      setStats(cache.stats || stats);
      setIsInitialLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache.cacheKey, currentCacheKey]);

  // -------------------------------------------------------------------
  // Fetch a page of products + (optional) stats
  // -------------------------------------------------------------------
  const fetchPage = useCallback(
    async (opts = {}) => {
      const {
        page = pageIndex,
        size = pageSize,
        sort = sortField,
        dir = sortDirection,
        filters = appliedFilterConfig,
        showPageLoader = true,
        includeCount = true,
        totalCountHint = 0,
        storeIdsOverride,
        storesToFetchOverride,
      } = opts;

      const effectiveStoreIds =
        storeIdsOverride ??
        (storeIds.length > 0 ? storeIds : lastNonEmptyStoreIdsRef.current);
      const effectiveStoresToFetch =
        storesToFetchOverride ??
        (storesToFetch.length > 0 ? storesToFetch : lastNonEmptyStoresRef.current);

      if (!userId) return;
      if (!effectiveStoreIds || effectiveStoreIds.length === 0) return;

      const reqId = ++pageReqIdRef.current;
      if (pageAbortRef.current) pageAbortRef.current.abort();
      const controller = new AbortController();
      pageAbortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), PAGE_REQUEST_TIMEOUT_MS);
      if (statsAbortRef.current) statsAbortRef.current.abort();
      const statsController = new AbortController();
      statsAbortRef.current = statsController;

      if (showPageLoader) setIsLoadingPage(true);
      if (showPageLoader) pageLoadingStartedAtRef.current = Date.now();
      setError(null);

      try {
        const runPageQuery = () =>
          queryProductsPage({
            userId,
            storeIds: effectiveStoreIds,
            organizationId: activeOrganizationId || undefined,
            filterConfig: filters,
            sortField: sort,
            sortDirection: dir,
            pageIndex: page,
            pageSize: size,
            signal: controller.signal,
            includeCount,
            totalCountHint,
          });

        let pageResult;
        try {
          pageResult = await runPageQuery();
        } catch (firstErr) {
          if (isAbortError(firstErr)) throw firstErr;
          if (isAuthError(firstErr)) {
            const refreshed = await refreshSessionSilently(8000);
            if (refreshed) {
              pageResult = await runPageQuery();
            } else {
              throw firstErr;
            }
          } else {
            throw firstErr;
          }
        }

        if (controller.signal.aborted) return;
        if (reqId !== pageReqIdRef.current) return; // ✅ ignore stale response

        // ✅ RLS ghost detection: if we have stores but the query returned 0
        // rows, the session token may have expired (Supabase RLS silently
        // returns empty sets instead of errors for invalid JWTs). Force a
        // session refresh and retry once.
        if (
          pageResult.data.length === 0 &&
          effectiveStoreIds.length > 0 &&
          !opts._isRetryAfterRefresh
        ) {
          console.warn(
            "[Index] 0 products returned despite having stores — possible expired session (RLS ghost). Refreshing session and retrying..."
          );
          const refreshOk = await refreshSessionSilently(10000);
          if (refreshOk) {
            // Retry the same fetchPage call once with a flag to prevent loops
            try {
              const retryQuery = () =>
                queryProductsPage({
                  userId,
                  storeIds: effectiveStoreIds,
                  organizationId: activeOrganizationId || undefined,
                  filterConfig: filters,
                  sortField: sort,
                  sortDirection: dir,
                  pageIndex: page,
                  pageSize: size,
                  signal: controller.signal,
                  includeCount,
                  totalCountHint,
                });
              const retryResult = await retryQuery();
              if (!controller.signal.aborted && reqId === pageReqIdRef.current) {
                pageResult = retryResult;
                console.log(
                  "[Index] RLS ghost retry returned",
                  retryResult.data.length,
                  "products"
                );
              }
            } catch (retryErr) {
              if (!isAbortError(retryErr)) {
                console.error("[Index] RLS ghost retry failed:", retryErr);
              }
            }
          }
        }

        const products = pageResult.data.map((p) => ({
          ...p,
          storeName:
            effectiveStoresToFetch.find((s) => s.id === p.store_id)?.name || "",
        }));

        setPageProducts(products);
        setTotalCount(pageResult.totalCount);
        setStats((prev) => ({
          ...prev,
          totalProducts: pageResult.totalCount,
          totalStores: new Set(effectiveStoreIds).size,
        }));

        // Fetch full filtered stats for dashboard cards.
        // This is separate from page fetch so table pagination stays lightweight.
        queryProductStats({
          userId,
          storeIds: effectiveStoreIds,
          organizationId: activeOrganizationId || undefined,
          filterConfig: filters,
          signal: statsController.signal,
        })
          .then((statsResult) => {
            if (statsController.signal.aborted) return;
            setStats((prev) => ({
              ...prev,
              totalProducts: statsResult.totalProducts || pageResult.totalCount,
              totalStores: statsResult.totalStores,
              totalVendors: statsResult.totalVendors,
              totalTypes: statsResult.totalTypes,
              avgPrice: statsResult.avgPrice,
            }));
            lastStatsFetchAtRef.current = Date.now();
          })
          .catch((statsErr) => {
            if (isAbortError(statsErr)) return;
            console.error("[Index] stats fetch failed:", statsErr);
          });

        lastDataFetchAtRef.current = Date.now();
      } catch (err) {
        if (isAbortError(err)) return;
        const msg =
          err instanceof Error ? err.message : "Failed to load products";
        setError(msg);
        toast({
          title: "Error loading products",
          description: msg,
          variant: "destructive",
        });
      } finally {
        clearTimeout(timeoutId);
        if (pageAbortRef.current === controller) {
          pageAbortRef.current = null;
        }
        if (statsAbortRef.current === statsController) {
          statsAbortRef.current = null;
        }
        if (reqId === pageReqIdRef.current) {
          setIsLoadingPage(false);
          setIsInitialLoading(false);
          pageLoadingStartedAtRef.current = 0;
        }
      }
    },
    [
      userId,
      storeIds,
      storesToFetch,
      activeOrganizationId,
      pageIndex,
      pageSize,
      sortField,
      sortDirection,
      appliedFilterConfig,
    ],
  );

  const fetchPageRef = useRef(fetchPage);
  useEffect(() => {
    fetchPageRef.current = fetchPage;
  }, [fetchPage]);
  useEffect(() => {
    isSyncingRef.current = isSyncing;
    try {
      // Mirror local page-level sync state into the global products store
      // so other modules (e.g. organizationStore) can check it.
      const setter = useProductsStore.getState().setIsSyncing;
      if (typeof setter === 'function') setter(isSyncing);
    } catch (e) {
      // ignore
    }
  }, [isSyncing]);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  // -------------------------------------------------------------------
  // Ensure stores are loaded, then fetch using latest store state
  // -------------------------------------------------------------------
  const ensureStoresThenFetch = useCallback(async () => {
    if (!isAuthenticated || !userId) return;

    // ✅ If we already have data and it's still fresh, DO NOTHING
    const last = lastDataFetchAtRef.current || 0;
    const isFresh =
      pageProducts.length > 0 && Date.now() - last < DATA_STALE_MS;
    if (isFresh) {
      
      return;
    }

    // ✅ Proactively validate / refresh the session before making
    //    data queries. This prevents the "RLS ghost" problem where
    //    an expired JWT causes all queries to silently return 0 rows.
    try {
      await ensureValidSession(8000, true);
    } catch (e) {
      console.warn("[Index] ensureStoresThenFetch: session check failed:", e);
    }

    // ✅ Only load stores if empty (do NOT force every time)
    const sm = useStoreManagement.getState();
    if (sm.stores.length === 0 && !sm.isLoading) {
      try {
        await sm.loadStores({
          organizationId: activeOrganizationId ?? undefined,
          force: true,
        });
      } catch (e) {
        console.error("[Index] ensureStoresThenFetch loadStores failed:", e);
        return; // no stores, can't fetch
      }
    }

    // ✅ Use latest store state
    const latestStores = useStoreManagement.getState().stores || [];
    const latestSelectedStoreId = useStoreManagement.getState().selectedStoreId;
    const latestViewMode = useStoreManagement.getState().viewMode;

    const latestStoresToFetch = (() => {
      if (latestViewMode === "combined" && latestSelectedStoreId === null)
        return latestStores;
      if (latestSelectedStoreId) {
        const st = latestStores.find((s) => s.id === latestSelectedStoreId);
        return st ? [st] : [];
      }
      return latestStores;
    })();

    const latestStoreIds = latestStoresToFetch.map((s) => s.id);
    if (latestStoreIds.length === 0) return;

    await fetchPageRef.current({
      showPageLoader: false,
      storeIdsOverride: latestStoreIds,
      storesToFetchOverride: latestStoresToFetch,
    });
  }, [
    isAuthenticated,
    userId,
    activeOrganizationId,
    pageProducts.length, // ✅ important so fresh check updates
  ]);

  // On mount/return, ensure stores are loaded and data is fetched.
  useEffect(() => {
    ensureStoresThenFetch();
  }, [ensureStoresThenFetch]);

  // -------------------------------------------------------------------
  // Manual refresh/sync entry point
  // -------------------------------------------------------------------
  const checkSyncAndLoad = useCallback(
    async (forceSync = false) => {
      if (!userId || storeIds.length === 0) {
        setIsInitialLoading(false);
        return;
      }
      if (isSyncingRef.current) return;

      // ✅ Always refresh the session before a manual sync/refresh to avoid
      //    silent RLS-ghost failures where an expired token returns 0 rows.
      try {
        await ensureValidSession(10000, true);
      } catch (e) {
        console.warn("[Index] checkSyncAndLoad: session refresh failed:", e);
      }

      try {
        if (forceSync) {
          setIsInitialLoading(true);
          setIsSyncing(true);
          // Prefer server-side sync to avoid browser background throttling.
          const payload = {
            storeIds: (storesToFetch || []).map((s) => s.id),
            organizationId: activeOrganizationId || null,
          };
          if (typeof supabase !== 'undefined' && supabase.functions && supabase.functions.invoke) {
            try {
              const fnResp = await supabase.functions.invoke('sync-stores', { body: JSON.stringify(payload) });
              if (fnResp && fnResp.data) {
                console.log('[Index] server-side sync response', fnResp.data);
              } else {
                console.warn('[Index] server-side sync returned no data; falling back to client sync');
                await syncStoresProductsFull(userId, storesToFetch, activeOrganizationId || undefined);
              }
            } catch (err) {
              console.error('[Index] server-side sync failed, falling back to client sync', err);
              await syncStoresProductsFull(userId, storesToFetch, activeOrganizationId || undefined);
            }
          } else {
            // No server functions available in this environment — run client-side sync
            await syncStoresProductsFull(userId, storesToFetch, activeOrganizationId || undefined);
          }
          try {
            // Prefer authoritative DB timestamp from shopify_store_sync_status
            const storeIdsForQuery = (storesToFetch || []).map((s) => s.id);
            const dbLast = await getOrgLastSyncTime(
              activeOrganizationId || undefined,
              storeIdsForQuery,
            );
            const ts = dbLast || new Date().toISOString();
            console.log('[Index] set lastSyncAt (DB or fallback) ->', ts);
            setLastSyncAt(ts);
          } catch (e) {
            console.warn('[Index] failed to read last sync from DB, falling back to client timestamp', e);
            try {
              const ts = new Date().toISOString();
              setLastSyncAt(ts);
            } catch (err) {
              console.error('[Index] failed to set lastSyncAt fallback:', err);
            }
          }
          await fetchPageRef.current({
            page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
            showPageLoader: false,
            includeCount: true,
          });
        } else {
          await fetchPageRef.current({
            page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
            showPageLoader: false,
          });
        }
      } catch (err) {
        if (!isAbortError(err)) {
          console.error("[Index] checkSyncAndLoad error:", err);
          if (forceSync) {
            toast({
              title: "Sync failed",
              description:
                err instanceof Error ? err.message : "Could not sync stores.",
              variant: "destructive",
            });
          }
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (forceSync) setIsSyncing(false);
        setIsInitialLoading(false);
      }
    },
    [
      userId,
      storeIds,
      storesToFetch,
      activeOrganizationId,
      setLastSyncAt,
    ],
  );

  // When stores are ready, do initial load/sync check
  useEffect(() => {
    if (isLoadingStores) return;
    if (storeIds.length === 0) {
      // don't blank UI
      setIsInitialLoading(false);
      initializedContextRef.current = "";
      return;
    }

    // Only run initial fetch when user/org/store-context changes.
    const contextKey = `${userId || ""}|${activeOrganizationId || ""}|${storesKey}`;
    if (initializedContextRef.current === contextKey) return;
    initializedContextRef.current = contextKey;

    fetchPageRef.current({
      page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
      showPageLoader: false,
      includeCount: true,
    });
  }, [storesKey, isLoadingStores, storeIds.length, userId, activeOrganizationId]);

  // Refetch on pagination / sort / filter changes
  useEffect(() => {
    if (storeIds.length === 0) return;
    if (isInitialLoading) return;
    fetchPage({
      includeCount: true,
      totalCountHint: 0,
    });
  }, [
    pageIndex,
    pageSize,
    sortField,
    sortDirection,
    appliedFilterConfig,
    storeIds.length,
    storesKey,
    activeOrganizationId,
    userId,
    isInitialLoading,
    fetchPage,
  ]);

  useEffect(() => {
    syncCheckRef.current = checkSyncAndLoad;
  }, [checkSyncAndLoad]);

  // Persist current dashboard view so tab-refresh can restore filters/sort/page.
  useEffect(() => {
    writeDashboardViewState({
      pageIndex,
      sortField,
      sortDirection,
      appliedFilterConfig,
      pageSize,
    });
  }, [pageIndex, sortField, sortDirection, appliedFilterConfig, pageSize]);

  // Soft-recover on tab switch (hidden -> visible): refresh session + refetch data.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        writeDashboardViewState({
          pageIndex: pageIndexRef.current,
          sortField,
          sortDirection,
          appliedFilterConfig,
          pageSize,
        });
        return;
      }

      if (document.visibilityState === "visible" && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        writeDashboardViewState({
          pageIndex: pageIndexRef.current,
          sortField,
          sortDirection,
          appliedFilterConfig,
          pageSize,
        });

        // ✅ CHANGED: Instead of a full page reload (which can lose session
        //    state and cause all-zero stats), always do a soft recovery:
        //    refresh the session token first, then refetch data.
        try {
          console.log('[Index] Tab visible again — refreshing session and refetching data');
          ensureValidSession(10000, true).then(() => {
            fetchPageRef.current?.({
              page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
              showPageLoader: false,
              includeCount: true,
            });
          }).catch(() => {});
          return;
        } catch (e) {
          console.warn('[Index] failed to perform location check for reload', e);
        }

        // Soft recovery for other routes: refresh session then refetch current page
        ensureValidSession(8000, true).then(() => {
          fetchPageRef.current?.({
            page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
            showPageLoader: false,
            includeCount: true,
          });
        }).catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sortField, sortDirection, appliedFilterConfig]);

  // Auto-sync logic removed: manual refresh via `checkSyncAndLoad(true)` remains.

  // Recover from stuck loading after tab sleep/background throttling.
  useEffect(() => {
    const STUCK_LOADING_MS = 15000;

    const recoverIfStuck = () => {
      if (!isLoadingPage) return;
      const startedAt = pageLoadingStartedAtRef.current || 0;
      if (!startedAt) return;
      if (Date.now() - startedAt < STUCK_LOADING_MS) return;

      if (pageAbortRef.current) {
        try {
          pageAbortRef.current.abort();
        } catch {}
        pageAbortRef.current = null;
      }

      setIsLoadingPage(false);
      setIsInitialLoading(false);
      pageLoadingStartedAtRef.current = 0;

      fetchPageRef.current({
        page: typeof pageIndexRef.current === "number" ? pageIndexRef.current : 0,
        showPageLoader: false,
        includeCount: true,
      });
    };

    const intervalId = setInterval(recoverIfStuck, 1500);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recoverIfStuck();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isLoadingPage]);

  // Table callbacks
  const handlePageChange = useCallback((newPage) => setPageIndex(newPage), []);
  const handlePageSizeChange = useCallback(
    (newSize) => {
      const size = Number(newSize) || 25;
      setPageSize(size);
      setPageIndex(0);
      writeDashboardViewState({
        pageIndex: 0,
        sortField,
        sortDirection,
        appliedFilterConfig,
        pageSize: size,
      });
    },
    [setPageSize, setPageIndex, sortField, sortDirection, appliedFilterConfig],
  );
  const handleSortChange = useCallback((field, dir) => {
    setSortField(field);
    setSortDirection(dir);
    setPageIndex(0);
  }, []);
  const handleFilterApply = useCallback((config) => {
    setAppliedFilterConfig(config);
    setPageIndex(0);
  }, []);

  // Export
  const handleExport = async () => {
    console.log('[Index] handleExport called', { canExport, isExporting });
    if (!canExport) {
      toast({
        title: "Session initializing",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    const columnsToExport = selectedColumns.length > 0 ? selectedColumns : [];
    if (columnsToExport.length === 0) {
      toast({
        title: "No columns selected",
        description: "Please wait for the table to load columns.",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);
    console.log("[handleExport] starting export", {
      userId,
      storeIds,
      activeOrganizationId,
      filter: appliedFilterConfig,
    });
    const fallbackId = setTimeout(() => {
      console.warn("[handleExport] export fallback triggered (120s)");
      setIsExporting(false);
      toast({
        title: "Export timeout",
        description: "Export took too long and was cancelled.",
        variant: "destructive",
      });
    }, 120_000);
    try {
      const runExportQuery = () =>
        queryAllFilteredProducts({
          userId,
          storeIds,
          organizationId: activeOrganizationId || undefined,
          filterConfig: appliedFilterConfig,
          sortField,
          sortDirection,
        });

      // Retry on transient AbortError from the Supabase SDK (e.g. navigator.locks, network aborts)
      const maxAttempts = 3;
      let attempt = 0;
      let allProducts;
      while (attempt < maxAttempts) {
        try {
          allProducts = await runExportQuery();
          break;
        } catch (e) {
          if (isAbortError(e) && attempt < maxAttempts - 1) {
            attempt += 1;
            const backoff = 300 * attempt;
            console.warn(`[handleExport] transient AbortError, retrying export (attempt ${attempt}/${maxAttempts}) after ${backoff}ms`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw e;
        }
      }
      console.log("[handleExport] fetched products for export", {
        count: allProducts?.length,
      });

      if (allProducts.length === 0) {
        toast({
          title: "No products to export",
          description: "No products found matching the current filters.",
          variant: "destructive",
        });
        setIsExporting(false);
        clearTimeout(fallbackId);
        return;
      }

      const withNames = allProducts.map((p) => ({
        ...p,
        storeName: storesToFetch.find((s) => s.id === p.store_id)?.name || "",
      }));
      // Debug logging for export
      console.log('[Index] export: columnsToExport', columnsToExport);
      console.log('[Index] export: sample', withNames[0]);

      // Attempt server-side export via Supabase Edge Function for large exports.
      try {
        const payload = {
          storeIds,
          organizationId: activeOrganizationId || null,
          filterConfig: appliedFilterConfig,
          selectedColumns: columnsToExport,
        };
        // Try using the Supabase Functions API (supabase client available globally)
        // If it fails, fall back to client-side export.
        if (typeof supabase !== 'undefined' && supabase.functions && supabase.functions.invoke) {
          try {
            const fnResp = await supabase.functions.invoke('export-products', { body: JSON.stringify(payload) });
            if (fnResp.error) throw fnResp.error;

            // fnResp.data may be ArrayBuffer / string depending on client; handle both
            let blob;
            if (fnResp.data instanceof ArrayBuffer) {
              blob = new Blob([fnResp.data], { type: 'text/csv' });
            } else if (typeof fnResp.data === 'string') {
              blob = new Blob([fnResp.data], { type: 'text/csv' });
            } else if (fnResp.arrayBuffer) {
              const ab = await fnResp.arrayBuffer();
              blob = new Blob([ab], { type: 'text/csv' });
            }

            if (blob) {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'shopify-products-export.csv';
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              toast({ title: 'Export started', description: 'Your export is downloading.' });
            } else {
              // Fallback to client-side export
              exportToExcel(withNames, columnsToExport, 'shopify-products');
            }

            // end server export
            clearTimeout(fallbackId);
            setIsExporting(false);
            return;
          } catch (fnErr) {
            console.warn('[Index] server-side export failed, falling back to client export:', fnErr);
            // continue to client-side export
          }
        }

      } catch (e) {
        console.warn('[Index] server export attempt error', e);
      }

      // client-side fallback
      exportToExcel(withNames, columnsToExport, "shopify-products");
      toast({
        title: "Export successful",
        description: `Exported ${withNames.length} products${appliedFilterConfig.items.length > 0 ? " matching your filters" : ""} to Excel.`,
      });
    } catch (err) {
      console.error("[handleExport] Error:", err);
      const msg = String(err?.message || err?.details || err || '');
      const isNetwork = msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('network');
      const isCors = /cors|access-control|blocked/i.test(msg);
      if (isNetwork || isCors) {
        toast({
          title: 'Export failed (network)',
          description:
            'Could not fetch data from Supabase. This looks like a network or CORS issue — try refreshing, using a different browser/network, or check your Supabase CORS settings.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Export failed',
          description: err instanceof Error ? err.message : 'An error occurred.',
          variant: 'destructive',
        });
      }
    } finally {
      console.log("[handleExport] finished (finally)");
      clearTimeout(fallbackId);
      setIsExporting(false);
    }
  };

  const formatCurrency = (value, currency) => {
    return new Intl.NumberFormat("en-LK", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  };

  // ✅ Do not show huge skeleton if we already have data
  const showBigSkeleton = isInitialLoading && pageProducts.length === 0;

  const showStoresLoading =
    isAuthenticated && isLoadingStores && pageProducts.length === 0;
  const showNoStores =
    isAuthenticated && !isLoadingStores && stores.length === 0;

  return (
    <div className="min-h-screen bg-background w-full">
      <div className="w-full px-2 sm:px-3 lg:max-w-7xl lg:mx-auto lg:px-6 xl:px-8 py-3 sm:py-4 lg:py-8">
        <div className="w-full space-y-3 sm:space-y-4 lg:space-y-8 animate-fade-in">
          <DashboardHeader
            onExport={handleExport}
            onRefresh={() => checkSyncAndLoad(true)}
            isLoading={showBigSkeleton}
            isSyncing={isSyncing}
            isExporting={isExporting}
            isExportDisabled={!canExport}
            productCount={stats.totalProducts}
            lastSyncAt={lastSyncAt}
          />

          <div className="glass-card rounded-lg p-2 sm:p-4 w-full">
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 items-stretch sm:items-center justify-between">
              <StoreSelector />
              <AddStoreDialog />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-4 w-full">
            {showBigSkeleton ? (
              [...Array(5)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-[80px] sm:h-[120px] rounded-lg w-full"
                />
              ))
            ) : (
              <>
                <StatsCard
                  title="Total Products"
                  value={stats.totalProducts}
                  subtitle="Across stores"
                  icon={<Package className="h-5 w-5 text-primary" />}
                  className="w-full"
                />
                <StatsCard
                  title="Connected Stores"
                  value={stats.totalStores}
                  subtitle="Active"
                  icon={<Store className="h-5 w-5 text-primary" />}
                  className="w-full"
                />
                <StatsCard
                  title="Unique Vendors"
                  value={stats.totalVendors}
                  subtitle="Product suppliers"
                  icon={<Building2 className="h-5 w-5 text-primary" />}
                  className="w-full"
                />
                <StatsCard
                  title="Product Types"
                  value={stats.totalTypes}
                  subtitle="Categories"
                  icon={<Tags className="h-5 w-5 text-primary" />}
                  className="w-full"
                />
                <StatsCard
                  title="Average Price"
                  value={formatCurrency(stats.avgPrice, "LKR")}
                  subtitle="Across all products"
                  icon={<Banknote className="h-5 w-5 text-primary" />}
                  className="w-full"
                />
              </>
            )}
          </div>

          <div className="space-y-4">
            {showStoresLoading ? (
              <>
                <Skeleton className="h-[60px] rounded-lg w-full" />
                <Skeleton className="h-[400px] sm:h-[450px] md:h-[500px] rounded-lg w-full" />
              </>
            ) : error ? (
              <div className="glass-card rounded-lg p-12 text-center">
                <p className="text-destructive font-medium mb-2">
                  Failed to load products
                </p>
                <p className="text-muted-foreground text-sm mb-4">{error}</p>
                <button
                  onClick={() => fetchPage()}
                  className="text-primary hover:underline text-sm font-medium"
                >
                  Try again
                </button>
              </div>
            ) : showNoStores ? (
              <div className="glass-card rounded-lg p-12 text-center">
                <Store className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="font-medium mb-2">No stores connected</p>
                <p className="text-muted-foreground text-sm mb-4">
                  Add a Shopify store to start viewing product data.
                </p>
                <AddStoreDialog />
                {storesError ? (
                  <p className="text-destructive text-sm mt-4">
                    {String(storesError)}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg">
                <ProductsTable
                  products={pageProducts}
                  totalCount={totalCount}
                  isLoadingPage={isLoadingPage}
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  appliedFilterConfig={appliedFilterConfig}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  onSortChange={handleSortChange}
                  onFilterApply={handleFilterApply}
                  onColumnsChange={setSelectedColumns}
                  showStoreColumn={storesToFetch.length > 1}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Index;
