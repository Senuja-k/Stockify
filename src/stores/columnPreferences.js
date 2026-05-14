import { create } from 'zustand';
import { saveColumnPreferences, getColumnPreferences } from '@/lib/supabase-utils';
import { auth } from '@/lib/supabase';

export const useColumnPreferences = create((set, get) => ({
  preferences: new Map(),
  isLoading: false,
  _dbLoaded: false,

  loadPreferences: async () => {
    // Only load once per session; re-call only after resetPreferences
    if (get()._dbLoaded) return;

    const session = await auth.getSession();
    const user = session.data.session?.user;
    if (!user) {
      set({ preferences: new Map(), _dbLoaded: true });
      return;
    }

    set({ isLoading: true });
    try {
      const preferences = await getColumnPreferences(user.id);
      set({ preferences, isLoading: false, _dbLoaded: true });
    } catch (error) {
      console.error('Failed to load column preferences:', error);
      set({ isLoading: false, _dbLoaded: true });
    }
  },

  setColumnVisibility: async (key, visible) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;

    set((state) => {
      const newPrefs = new Map(state.preferences);
      const existing = newPrefs.get(key);
      if (existing) {
        newPrefs.set(key, { ...existing, visible });
      } else {
        newPrefs.set(key, { key, visible, order: newPrefs.size });
      }
      return { preferences: newPrefs };
    });

    if (user) {
      try {
        const newPrefs = get().preferences;
        await saveColumnPreferences(user.id, newPrefs);
      } catch (error) {
        console.error('Failed to save column visibility:', error);
      }
    }
  },

  updateColumnOrder: async (key, newOrder) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;

    set((state) => {
      const newPrefs = new Map(state.preferences);
      const current = newPrefs.get(key);
      if (current) {
        newPrefs.set(key, { ...current, order: newOrder });
      }
      return { preferences: newPrefs };
    });

    if (user) {
      try {
        const newPrefs = get().preferences;
        await saveColumnPreferences(user.id, newPrefs);
      } catch (error) {
        console.error('Failed to save column order:', error);
      }
    }
  },

  setColumnOrder: async (columns) => {
    const session = await auth.getSession();
    const user = session.data.session?.user;

    set(() => {
      const newPrefs = new Map();
      columns.forEach((col, index) => {
        newPrefs.set(col.key, { key: col.key, visible: col.visible ?? true, order: index });
      });
      return { preferences: newPrefs };
    });

    if (user) {
      try {
        const newPrefs = get().preferences;
        await saveColumnPreferences(user.id, newPrefs);
      } catch (error) {
        console.error('Failed to save column order:', error);
      }
    }
  },

  resetPreferences: async () => {
    const session = await auth.getSession();
    const user = session.data.session?.user;

    set({ preferences: new Map(), _dbLoaded: false });

    if (user) {
      try {
        await saveColumnPreferences(user.id, new Map());
      } catch (error) {
        console.error('Failed to reset preferences:', error);
      }
    }
  },

  initializePreferences: (detectedColumns) => {
    set((state) => {
      const newPrefs =
        state.preferences instanceof Map
          ? new Map(state.preferences)
          : new Map();

      // Add any new columns that aren't in preferences yet
      detectedColumns.forEach((col, index) => {
        if (!newPrefs.has(col.key)) {
          newPrefs.set(col.key, {
            key: col.key,
            visible: col.visible ?? true,
            order: newPrefs.size + index,
          });
        }
      });

      return { preferences: newPrefs };
    });
  },
}));

