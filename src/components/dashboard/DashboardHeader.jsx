import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Download,
  RefreshCw,
  Store,
  LogOut,
  FileText,
  Building2,
  Users,
} from "lucide-react";
import { useAuth } from "@/stores/authStore.jsx";
import { useOrganization } from "@/stores/organizationStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";

export function DashboardHeader({
  onExport,
  onRefresh,
  isLoading,
  isExporting = false,
  isExportDisabled = false,
  productCount,
  isSyncing,
  lastSyncAt,
}) {
  console.log('[DashboardHeader] render', { productCount, isExporting, isExportDisabled });
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const {
    organizations,
    activeOrganizationId,
    setActiveOrganization,
    createOrganization,
  } = useOrganization();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const handleCreateOrganization = async () => {
    if (!organizationName.trim()) {
      toast({
        title: "Organization name required",
        description: "Please enter a name for your organization.",
        variant: "destructive",
      });
      return;
    }

    setIsCreating(true);
    try {
      await createOrganization(organizationName.trim());
      setOrganizationName("");
      setIsCreateOpen(false);
      toast({
        title: "Organization created",
        description: "Your new organization is ready.",
      });
    } catch (error) {
      toast({
        title: "Failed to create organization",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-8">
        <div className="flex-1 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Stockify</h1>
          <p className="text-muted-foreground text-sm">View and analyze your Shopify store products</p>
        </div>

        <div className="flex items-center gap-2">
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle>Create organization</DialogTitle>
                <DialogDescription>
                  Create a workspace to share stores and reports with your team.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="org-name">Organization name</Label>
                <Input
                  id="org-name"
                  placeholder="Acme Inc"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  disabled={isCreating}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateOpen(false)} disabled={isCreating}>
                  Cancel
                </Button>
                <Button onClick={handleCreateOrganization} disabled={isCreating}>
                  {isCreating ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {organizations.length === 0 && (
            <Button variant="outline" size="sm" onClick={() => setIsCreateOpen(true)}>
              Create Organization
            </Button>
          )}

          {organizations.length > 0 && (
            <Select value={activeOrganizationId || undefined} onValueChange={(value) => setActiveOrganization(value)}>
              <SelectTrigger className="h-8 w-[210px]">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <SelectValue placeholder="Select organization" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {user && (
            <div className="text-sm text-muted-foreground">Welcome, <span className="font-medium">{user.name}</span></div>
          )}

          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/organizations'; }} className="gap-2">
            <Users className="h-4 w-4" />
            Organizations
          </Button>

          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/custom-reports'; }} className="gap-2">
            <FileText className="h-4 w-4" />
            Custom Reports
          </Button>

          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading || isSyncing} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${isLoading || isSyncing ? "animate-spin" : ""}`} />
            {isSyncing ? "Syncing..." : "Refresh"}
          </Button>

          <div className="text-xs text-muted-foreground ml-1">Last sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "Never"}</div>

          <Button
            size="sm"
            onClick={() => {
              console.log('[DashboardHeader] export button clicked', { productCount, isExporting, isExportDisabled });
              try {
                onExport?.();
              } catch (e) {
                console.error('[DashboardHeader] onExport threw', e);
                throw e;
              }
            }}
            disabled={productCount === 0 || isExporting || isExportDisabled}
            className="gap-2 gradient-primary hover:opacity-90 transition-opacity"
          >
            <Download className={`h-4 w-4 ${isExporting ? "animate-spin" : ""}`} />
            {isExporting ? "Exporting..." : "Export to Excel"}
          </Button>

          <Button variant="outline" size="sm" onClick={handleLogout} className="gap-2">
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </div>
    </div>
  );
}

