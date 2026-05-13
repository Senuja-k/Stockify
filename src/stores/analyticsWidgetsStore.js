import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

/**
 * Widget shape:
 * {
 *   id: string,
 *   organizationId: string,
 *   title: string,
 *   displayType: 'card' | 'bar' | 'pie' | 'line' | 'area',
 *   // For simple aggregations:
 *   aggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'custom',
 *   column: string,          // field key from products table (e.g. "variantPrice")
 *   // For custom formula (aggregation === 'custom'):
 *   formula: string,         // JS expression operating on (rows) array, e.g. "rows.reduce((a,r)=>a+r.variantPrice,0)"
 *   // For charts that need a breakdown dimension:
 *   groupByColumn: string | null,  // e.g. "vendor", "productType"
 *   position: number,
 *   createdAt: string,
 * }
 */

export const useAnalyticsWidgetsStore = create((set, get) => ({
  widgets: [],
  isLoading: false,
  error: null,

  loadWidgets: async (organizationId) => {
    if (!organizationId) return;
    set({ isLoading: true, error: null });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { set({ isLoading: false }); return; }

      const { data, error } = await supabase
        .from('analytics_widgets')
        .select('*')
        .eq('user_id', session.user.id)
        .eq('organization_id', organizationId)
        .order('position', { ascending: true });

      if (error) throw error;

      set({
        widgets: (data || []).map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          title: row.title,
          displayType: row.display_type,
          aggregation: row.aggregation,
          column: row.column_key,
          formula: row.formula,
          groupByColumn: row.group_by_column,
          position: row.position,
          createdAt: row.created_at,
        })),
        isLoading: false,
      });
    } catch (err) {
      console.error('[analyticsWidgetsStore] loadWidgets error:', err);
      set({ isLoading: false, error: err.message });
    }
  },

  addWidget: async (organizationId, widget) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const position = get().widgets.length;
    const { data, error } = await supabase
      .from('analytics_widgets')
      .insert({
        user_id: session.user.id,
        organization_id: organizationId,
        title: widget.title,
        display_type: widget.displayType,
        aggregation: widget.aggregation,
        column_key: widget.column || null,
        formula: widget.formula || null,
        group_by_column: widget.groupByColumn || null,
        position,
      })
      .select()
      .single();

    if (error) throw error;

    set((state) => ({
      widgets: [
        ...state.widgets,
        {
          id: data.id,
          organizationId: data.organization_id,
          title: data.title,
          displayType: data.display_type,
          aggregation: data.aggregation,
          column: data.column_key,
          formula: data.formula,
          groupByColumn: data.group_by_column,
          position: data.position,
          createdAt: data.created_at,
        },
      ],
    }));
  },

  removeWidget: async (widgetId) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('analytics_widgets')
      .delete()
      .eq('id', widgetId)
      .eq('user_id', session.user.id);

    if (error) throw error;
    set((state) => ({ widgets: state.widgets.filter((w) => w.id !== widgetId) }));
  },

  updateWidget: async (widgetId, updates) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const dbUpdates = {};
    if (updates.title       !== undefined) dbUpdates.title           = updates.title;
    if (updates.displayType !== undefined) dbUpdates.display_type    = updates.displayType;
    if (updates.aggregation !== undefined) dbUpdates.aggregation     = updates.aggregation;
    if (updates.column      !== undefined) dbUpdates.column_key      = updates.column;
    if (updates.formula     !== undefined) dbUpdates.formula         = updates.formula;
    if (updates.groupByColumn !== undefined) dbUpdates.group_by_column = updates.groupByColumn;

    const { error } = await supabase
      .from('analytics_widgets')
      .update(dbUpdates)
      .eq('id', widgetId)
      .eq('user_id', session.user.id);

    if (error) throw error;

    set((state) => ({
      widgets: state.widgets.map((w) =>
        w.id === widgetId ? { ...w, ...updates } : w
      ),
    }));
  },
}));
