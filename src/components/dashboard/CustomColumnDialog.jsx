import { useState } from 'react';
import { Plus, Trash2, Code2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useCustomColumnsStore } from '@/stores/customColumnsStore';

function previewFormula(formula, sampleRow) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('row', `"use strict"; return (${formula})`);
    const result = fn(sampleRow);
    if (result !== null && result !== undefined && typeof result === 'object' && 'value' in result) {
      return {
        value: result.value !== null && result.value !== undefined ? String(result.value) : '—',
        color: result.color || null,
        error: null,
      };
    }
    return {
      value: result !== null && result !== undefined ? String(result) : '—',
      color: null,
      error: null,
    };
  } catch (e) {
    return { value: null, color: null, error: e.message };
  }
}

export function CustomColumnDialog({ open, onOpenChange, organizationId, sampleRow }) {
  const { customColumns, addCustomColumn, removeCustomColumn } = useCustomColumnsStore();
  const [name, setName] = useState('');
  const [formula, setFormula] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const preview = formula.trim() ? previewFormula(formula, sampleRow || {}) : null;

  const handleAdd = async () => {
    if (!name.trim()) {
      toast({ title: 'Column name required', variant: 'destructive' });
      return;
    }
    if (!formula.trim()) {
      toast({ title: 'Formula required', variant: 'destructive' });
      return;
    }
    if (preview?.error) {
      toast({ title: 'Formula has errors', description: preview.error, variant: 'destructive' });
      return;
    }
    setIsSaving(true);
    try {
      await addCustomColumn(organizationId, { name: name.trim(), formula: formula.trim() });
      toast({ title: 'Custom column added' });
      setName('');
      setFormula('');
    } catch (e) {
      toast({ title: 'Failed to add column', description: e.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (columnId) => {
    setDeletingId(columnId);
    try {
      await removeCustomColumn(columnId);
      toast({ title: 'Column deleted' });
    } catch (e) {
      toast({ title: 'Failed to delete column', description: e.message, variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Code2 className="h-5 w-5" />
            Custom Columns
          </DialogTitle>
        </DialogHeader>

        {/* Existing columns list */}
        {customColumns.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Active columns
            </p>
            {customColumns.map((col) => (
              <div
                key={col.id}
                className="flex items-center justify-between gap-2 p-2 border rounded-md bg-muted/30"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{col.name}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">{col.formula}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                  onClick={() => handleDelete(col.id)}
                  disabled={deletingId === col.id}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add new column form */}
        <div className="space-y-4 pt-2 border-t">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Add new column
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="col-name">Column Name</Label>
            <Input
              id="col-name"
              placeholder="e.g. Tax Amount"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="col-formula">
              Formula{' '}
              <span className="text-xs text-muted-foreground font-normal">
                — use <code className="bg-muted px-1 rounded text-xs">row</code> to access fields
              </span>
            </Label>
            <Textarea
              id="col-formula"
              placeholder="e.g. (row.price || 0) * (row.totalInventory || 0)"
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              className="font-mono text-sm min-h-[80px]"
            />
            <p className="text-xs text-muted-foreground">
              Examples:{' '}
              <code className="bg-muted px-1 rounded">row.price * 0.15</code>
              &nbsp;·&nbsp;
              <code className="bg-muted px-1 rounded">row.price &gt; 50 ? &apos;Premium&apos; : &apos;Standard&apos;</code>
              &nbsp;·&nbsp;
              <span className="block mt-1">With colour: return an object with <code className="bg-muted px-1 rounded">{'{'}value, color{'}'}</code></span>
              <code className="bg-muted px-1 rounded block mt-0.5 whitespace-pre-wrap">{`(parseInt(row.totalInventory)||0) < 5
  ? { value: 'Low', color: '#ef4444' }
  : { value: 'OK', color: '#22c55e' }`}</code>
            </p>
          </div>

          {/* Live preview */}
          {preview && (
            <div
              className={`p-2 rounded text-xs font-mono border ${
                preview.error
                  ? 'bg-destructive/10 text-destructive border-destructive/30'
                  : 'bg-muted text-foreground border-border'
              }`}
            >
              {preview.error ? `⚠ ${preview.error}` : (
                <span>
                  Preview (first row):{' '}
                  {preview.color ? (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                      style={{ backgroundColor: preview.color + '22', color: preview.color, border: `1px solid ${preview.color}44` }}
                    >
                      {preview.value}
                    </span>
                  ) : preview.value}
                </span>
              )}
            </div>
          )}

          <Button onClick={handleAdd} disabled={isSaving} className="w-full gap-2">
            <Plus className="h-4 w-4" />
            {isSaving ? 'Adding...' : 'Add Column'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
