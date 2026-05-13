import { create } from 'zustand';
import { auth } from '@/lib/supabase';
import { getCustomColumns, saveCustomColumn, deleteCustomColumn } from '@/lib/supabase-utils';

export const useCustomColumnsStore = create((set, get) => ({
  customColumns: [],
  isLoading: false,

  loadCustomColumns: async (organizationId) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;
    if (!user) {
      set({ customColumns: [] });
      return;
    }
    set({ isLoading: true });
    try {
      const columns = await getCustomColumns(user.id, organizationId);
      set({ customColumns: columns, isLoading: false });
    } catch (error) {
      console.error('[customColumnsStore] Failed to load custom columns:', error);
      set({ isLoading: false });
    }
  },

  addCustomColumn: async (organizationId, { name, formula }) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not authenticated');

    const column = await saveCustomColumn(user.id, organizationId, {
      name,
      formula,
      position: get().customColumns.length,
    });
    set((state) => ({ customColumns: [...state.customColumns, column] }));
    return column;
  },

  removeCustomColumn: async (columnId) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not authenticated');

    await deleteCustomColumn(columnId, user.id);
    set((state) => ({
      customColumns: state.customColumns.filter((c) => c.id !== columnId),
    }));
  },
}));
