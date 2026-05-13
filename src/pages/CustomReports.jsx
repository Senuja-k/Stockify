import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../stores/authStore';
import { useReportManagement } from '../stores/reportManagement';
import { useStoreManagement } from '../stores/storeManagement';
import { auth } from '../lib/supabase';
import { getVariantsByStore, getSyncStatus } from '../lib/shopify-sync-utils';
import { detectProductFields } from '../lib/columnDetection';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ScrollArea } from '../components/ui/scroll-area';
import { Checkbox } from '../components/ui/checkbox';
import { useToast } from '../components/ui/use-toast';
import { Plus, Copy, Trash2, AlertCircle, Loader2, Edit } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SimpleHeader } from '../components/dashboard/SimpleHeader';
import { useOrganization } from '../stores/organizationStore';
import { useCustomColumnsStore } from '../stores/customColumnsStore';

export function CustomReports() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();
  const { reports, createReport, deleteReport, loadReports } = useReportManagement();
  const { stores, loadStores } = useStoreManagement();
  const activeOrganizationId = useOrganization((state) => state.activeOrganizationId);
  const { customColumns, loadCustomColumns } = useCustomColumnsStore();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reportName, setReportName] = useState('');
  const [selectedStore, setSelectedStore] = useState('');
  const [selectedColumns, setSelectedColumns] = useState([]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [availableColumns, setAvailableColumns] = useState([]);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [usingAdminApi, setUsingAdminApi] = useState(false);
  const [editingPasswordId, setEditingPasswordId] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [reportLastSyncMap, setReportLastSyncMap] = useState({});

  // Load org-scoped data on mount/org change
  useEffect(() => {
    if (!activeOrganizationId || !isAuthenticated) return;
    loadStores();
    loadReports();
    // Reset selection when org changes
    setSelectedStore('');
    setSelectedColumns([]);
    setAvailableColumns([]);
    setLastSyncAt(null);
    setReportLastSyncMap({});
  }, [activeOrganizationId, isAuthenticated, loadStores, loadReports]);

  // Base URL for share links: prefer explicit env, fall back to redirect URI origin, then window.location
  const BASE_URL =
    import.meta.env.VITE_APP_URL ||
    (import.meta.env.VITE_SHOPIFY_REDIRECT_URI
      ? (() => {
          try {
            return new URL(import.meta.env.VITE_SHOPIFY_REDIRECT_URI).origin;
          } catch (e) {
            return window.location.origin;
          }
        })()
      : window.location.origin);

  // Load columns when store is selected
  useEffect(() => {
    if (!selectedStore) {
      setAvailableColumns([]);
      setSelectedColumns([]);
      setLastSyncAt(null);
      return;
    }

    const loadStoreColumns = async () => {
      setLoadingColumns(true);
      try {
        const session = await auth.getSession();
        const user = session.data.session?.user;
        if (!user) {
          throw new Error('User not authenticated');
        }

        let products = [];
        let isAdmin = false;

        if (selectedStore === 'all-stores') {
          // Load from all stores
          let latestSync = null;
          for (const store of stores) {
            isAdmin = isAdmin || !!store.adminToken;
            const syncStatus = await getSyncStatus(user.id, store.id, activeOrganizationId || undefined);
            if (syncStatus?.last_product_sync_at) {
              latestSync = !latestSync || syncStatus.last_product_sync_at > latestSync
                ? syncStatus.last_product_sync_at
                : latestSync;
            }
            const variants = await getVariantsByStore(user.id, [store.id], {}, activeOrganizationId || undefined);
            products.push(...variants.map((v) => ({
              ...v,
              id: v.id || v.shopify_product_id,
              title: v.title || '',
              status: v.status || 'UNKNOWN',
              variantPrice: v.variantPrice || v.price,
              price: v.variantPrice || v.price,
              storeId: store.id,
              storeName: store.name,
            })));
          }
          setLastSyncAt(latestSync);
          setUsingAdminApi(isAdmin);
        } else {
          // Load from single store
          const store = stores.find((s) => s.id === selectedStore);
          if (store) {
            isAdmin = !!store.adminToken;
            setUsingAdminApi(isAdmin);
            
            const syncStatus = await getSyncStatus(user.id, store.id, activeOrganizationId || undefined);
            setLastSyncAt(syncStatus?.last_product_sync_at || null);
            const variants = await getVariantsByStore(user.id, [store.id], {}, activeOrganizationId || undefined);
            products = variants.map((v) => ({
              ...v,
              id: v.id || v.shopify_product_id,
              title: v.title || '',
              status: v.status || 'UNKNOWN',
              variantPrice: v.variantPrice || v.price,
              price: v.variantPrice || v.price,
              storeId: store.id,
              storeName: store.name,
            }));
          }
        }

        const detected = detectProductFields(products);
        // Load custom columns so they appear in the column picker
        if (activeOrganizationId) await loadCustomColumns(activeOrganizationId);
        const salesKeys = ['__sales_qty__', '__sales_amount__'];
        const customKeys = useCustomColumnsStore.getState().customColumns.map((cc) => `__custom__${cc.id}`);
        const columnKeys = [...detected.map((col) => col.key), ...salesKeys, ...customKeys];
        setAvailableColumns(columnKeys);
        // Auto-select all columns by default
        setSelectedColumns(columnKeys);
      } catch (error) {
        console.error('Failed to load columns:', error);
        toast({
          title: 'Error',
          description: 'Failed to load available columns for this store',
          variant: 'destructive',
        });
        setAvailableColumns([]);
      } finally {
        setLoadingColumns(false);
      }
    };

    loadStoreColumns();
  }, [selectedStore, stores, toast, activeOrganizationId]);

  // Load last sync time per report from database (no cache)
  useEffect(() => {
    const loadReportSyncTimes = async () => {
      const session = await auth.getSession();
      const user = session.data.session?.user;
      if (!user || !activeOrganizationId) {
        setReportLastSyncMap({});
        return;
      }

      const nextMap = {};

      for (const report of reports) {
        if (!report.storeId) {
          nextMap[report.id] = null;
          continue;
        }

        if (report.storeId === 'all-stores') {
            let latest = null;
          for (const store of stores) {
            const syncStatus = await getSyncStatus(user.id, store.id, activeOrganizationId);
            if (syncStatus?.last_product_sync_at) {
              latest = !latest || syncStatus.last_product_sync_at > latest
                ? syncStatus.last_product_sync_at
                : latest;
            }
          }
          nextMap[report.id] = latest;
        } else {
          const syncStatus = await getSyncStatus(user.id, report.storeId, activeOrganizationId);
          nextMap[report.id] = syncStatus?.last_product_sync_at || null;
        }
      }

      setReportLastSyncMap(nextMap);
    };

    loadReportSyncTimes();
  }, [reports, stores, activeOrganizationId]);

  // Reload page when user switches back to this tab (avoids stale data)
  const _wasHidden = useRef(false);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        _wasHidden.current = true;
      } else if (document.visibilityState === 'visible' && _wasHidden.current) {
        _wasHidden.current = false;
        window.location.reload();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const handleCreateReport = async () => {
    if (!reportName.trim()) {
      toast({ title: 'Error', description: 'Report name is required', variant: 'destructive' });
      return;
    }
    if (!selectedStore) {
      toast({ title: 'Error', description: 'Please select a store', variant: 'destructive' });
      return;
    }
    if (selectedColumns.length === 0) {
      toast({ title: 'Error', description: 'Please select at least one column', variant: 'destructive' });
      return;
    }
    if (!password.trim()) {
      toast({ title: 'Error', description: 'Password is required', variant: 'destructive' });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: 'Error', description: 'Passwords do not match', variant: 'destructive' });
      return;
    }

    const storeName = selectedStore === 'all-stores' 
      ? 'All Stores' 
      : stores.find((s) => s.id === selectedStore)?.name || selectedStore;
    
    const newReport = await createReport({
      name: reportName,
      storeId: selectedStore,
      storeName,
      selectedColumns,
      password,
      filters: {},
    });

    // Copy share link to clipboard
    const shareLink = `${BASE_URL}/report/share/${newReport.shareLink}`;
    navigator.clipboard.writeText(shareLink);

    toast({
      title: 'Report Created',
      description: 'Share link copied to clipboard',
    });

    // Reset form
    setReportName('');
    setSelectedStore('');
    setSelectedColumns([]);
    setPassword('');
    setConfirmPassword('');
    setIsDialogOpen(false);
  };

  const handleUpdatePassword = async (reportId) => {
    if (!newPassword.trim()) {
      toast({ title: 'Error', description: 'New password is required', variant: 'destructive' });
      return;
    }
    if (newPassword !== confirmNewPassword) {
      toast({ title: 'Error', description: 'Passwords do not match', variant: 'destructive' });
      return;
    }

    try {
      const report = reports.find((r) => r.id === reportId);
      if (report) {
        await useReportManagement.setState((state) => {
          const updated = state.reports.map((r) =>
            r.id === reportId ? { ...r, password: newPassword, updatedAt: new Date().toISOString() } : r
          );
          return { reports: updated };
        });
        
        // Call updateReport from the store
        const { updateReport: updateReportFn } = useReportManagement.getState();
        await updateReportFn(reportId, { password: newPassword });
        
        setEditingPasswordId(null);
        setNewPassword('');
        setConfirmNewPassword('');
        toast({ title: 'Password updated successfully' });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to update password',
        variant: 'destructive',
      });
    }
  };

  const handleDeleteReport = async (reportId) => {
    if (confirm('Are you sure you want to delete this report?')) {
      try {
        
        await deleteReport(reportId);
        
        toast({ title: 'Report deleted' });
      } catch (error) {
        console.error('[CustomReports] Failed to delete report:', error);
        toast({
          title: 'Delete failed',
          description: error instanceof Error ? error.message : 'Failed to delete report',
          variant: 'destructive',
        });
      }
    }
  };

  const handleCopyShareLink = (shareLink) => {
    const link = `${BASE_URL}/report/share/${shareLink}`;
    navigator.clipboard.writeText(link);
    toast({ title: 'Share link copied to clipboard' });
  };

  return (
    <div className="min-h-screen bg-background">
      <SimpleHeader 
        title="Custom Reports"
        subtitle="Create and manage shareable reports with password protection"
        showLogout={true}
        showHomeButton={true}
        showWelcome={false}
      />

      <div className="container mx-auto px-4 pt-4">
        <div className="text-sm text-muted-foreground">
          Last sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : '—'}
        </div>
      </div>
      
      <div className="container mx-auto py-8 px-4">
        {/* Create Report Dialog */}
        <div className="mb-8">
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Create New Report
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Custom Report</DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                {/* Report Name */}
                <div>
                  <Label htmlFor="report-name">Report Name</Label>
                  <Input
                    id="report-name"
                    placeholder="e.g., Q4 Sales Report"
                    value={reportName}
                    onChange={(e) => setReportName(e.target.value)}
                    className="mt-2"
                  />
                </div>

                {/* Store Selection */}
                <div>
                  <Label htmlFor="store-select">Store</Label>
                  <Select value={selectedStore} onValueChange={setSelectedStore}>
                    <SelectTrigger id="store-select" className="mt-2">
                      <SelectValue placeholder="Select a store" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all-stores">
                        All Stores
                      </SelectItem>
                      {stores.map((store) => (
                        <SelectItem key={store.id} value={store.id}>
                          {store.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Column Selection */}
                {availableColumns.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Label>Columns to Include</Label>
                      {!usingAdminApi && (
                        <span className="text-xs text-amber-600 font-medium">
                          ⚠️ Admin token needed for metafields & barcode
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {usingAdminApi ? '✓ Using Admin API - Full access' : 'Using Storefront API - Limited access'}
                    </p>
                    <ScrollArea className="border rounded-md p-3 mt-2 h-40">
                      <div className="space-y-2">
                        {availableColumns.map((col) => (
                          <div key={col} className="flex items-center space-x-2">
                            <Checkbox
                              id={`col-${col}`}
                              checked={selectedColumns.includes(col)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedColumns([...selectedColumns, col]);
                                } else {
                                  setSelectedColumns(selectedColumns.filter((c) => c !== col));
                                }
                              }}
                            />
                            <label
                              htmlFor={`col-${col}`}
                              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                            >
                              {col}
                            </label>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {loadingColumns && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
                    <p className="text-sm text-muted-foreground">Loading available columns...</p>
                  </div>
                )}

                {/* Password */}
                <div>
                  <Label htmlFor="password">Report Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Enter password (no username needed)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-2"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Users will only need this password to view the report
                  </p>
                </div>

                {/* Confirm Password */}
                <div>
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-2"
                  />
                </div>

                {/* Create Button */}
                <Button onClick={handleCreateReport} className="w-full">
                  Create Report & Get Share Link
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Reports List */}
        <div className="grid gap-4">
          {reports.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="pt-8">
                <div className="text-center text-muted-foreground">
                  <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No reports created yet</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            reports.map((report) => (
              <Card key={report.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{report.name}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {report.storeName} • {report.selectedColumns.length} column{report.selectedColumns.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/custom-reports/edit/${report.id}`)}
                        className="text-primary hover:bg-primary/10"
                        title="Edit report"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteReport(report.id)}
                        className="text-destructive hover:bg-destructive/10"
                        title="Delete report"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Column Count */}
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">Columns</p>
                      <p className="text-sm font-medium">{report.selectedColumns.length} columns</p>
                    </div>

                    {/* Last Sync */}
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">Last sync</p>
                      <p className="text-sm font-medium">
                        {reportLastSyncMap[report.id]
                          ? new Date(reportLastSyncMap[report.id]).toLocaleString()
                          : '—'}
                      </p>
                    </div>

                    {/* Share Link */}
                    <div className="flex items-center gap-2 bg-muted p-3 rounded">
                      <code className="text-xs flex-1 truncate">
                        {BASE_URL}/report/share/{report.shareLink}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleCopyShareLink(report.shareLink)}
                        className="h-8 w-8 flex-shrink-0"
                        title="Copy share link"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Password Change */}
                    {editingPasswordId === report.id ? (
                      <div className="border-t pt-3 mt-3 space-y-2">
                        <Label htmlFor={`new-password-${report.id}`} className="text-xs">New Password</Label>
                        <Input
                          id={`new-password-${report.id}`}
                          type="password"
                          placeholder="Enter new password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          className="text-xs"
                        />
                        <Label htmlFor={`confirm-new-password-${report.id}`} className="text-xs">Confirm Password</Label>
                        <Input
                          id={`confirm-new-password-${report.id}`}
                          type="password"
                          placeholder="Confirm new password"
                          value={confirmNewPassword}
                          onChange={(e) => setConfirmNewPassword(e.target.value)}
                          className="text-xs"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleUpdatePassword(report.id)}
                            className="flex-1"
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingPasswordId(null);
                              setNewPassword('');
                              setConfirmNewPassword('');
                            }}
                            className="flex-1"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingPasswordId(report.id)}
                        className="w-full text-xs"
                      >
                        Change Password
                      </Button>
                    )}

                    {/* Created Date */}
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(report.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
