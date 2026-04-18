import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { saveStore, getStores, updateStoreInSupabase, deleteStoreFromSupabase } from '@/lib/supabase-utils';
import { useOrganization } from '@/stores/organizationStore';
import { useAuth } from '@/stores/authStore.jsx';

export const useStoreManagement = create()(
  persist(
    (set, get) => ({
      stores: [],
      selectedStoreId: null,
      viewMode: 'combined',
      isLoading: false,
      error: null, // ✅ NEW

      // ✅ UPDATED: accepts options { organizationId, force }
      loadStores: async (options = {}) => {
        const { organizationId: orgFromCaller, force = false } = options;
        console.log('[storeManagement] loadStores called', { orgFromCaller, force });

        // Prevent concurrent calls
        if (get().isLoading && !force) {
          
          return;
        }

        // Only load if authenticated
        const isAuthenticated = useAuth.getState().isAuthenticated;
        if (!isAuthenticated) {
          
          set({ stores: [], isLoading: false, error: null });
          return;
        }

        
        set({ isLoading: true, error: null });

        try {
          // Use persisted user from authStore instead of async getSession
          const user = useAuth.getState().user;
          

          if (!user) {
            console.log('[storeManagement] no user yet; aborting loadStores');
            // ✅ Don’t wipe persisted stores (auth may still hydrate)
            return;
          }

          // ✅ Prefer org passed from caller
          const organizationId = orgFromCaller ?? useOrganization.getState().activeOrganizationId;

          if (!organizationId) {
            console.log('[storeManagement] no organizationId provided; aborting loadStores');
            // ✅ IMPORTANT: do NOT clear stores here (this caused “No stores connected”)
            return;
          }

          
          console.log('[storeManagement] fetching stores for org', organizationId, 'user', user?.id);
          let stores = await getStores(user.id, organizationId);
          if (stores === null) {
            return;
          }

          // ✅ RLS ghost detection: if we had stores locally but the DB returned
          // empty, the JWT may have expired (Supabase RLS silently returns empty
          // sets for invalid JWTs). Refresh the session and retry once.
          const localStores = get().stores || [];
          if (stores.length === 0 && localStores.length > 0) {
            console.warn('[storeManagement] RLS ghost detected: had', localStores.length, 'stores locally but DB returned 0. Refreshing session and retrying...');
            try {
              const { refreshSessionSilently } = await import('@/lib/supabase');
              const refreshed = await refreshSessionSilently(8000);
              if (refreshed) {
                const retryStores = await getStores(user.id, organizationId);
                if (retryStores !== null && retryStores.length > 0) {
                  console.log('[storeManagement] RLS ghost retry succeeded:', retryStores.length, 'stores');
                  stores = retryStores;
                } else if (retryStores !== null && retryStores.length === 0) {
                  console.warn('[storeManagement] RLS ghost retry also returned 0 — stores may have been legitimately deleted');
                }
              } else {
                console.warn('[storeManagement] session refresh failed — keeping local stores');
                return;
              }
            } catch (retryErr) {
              console.error('[storeManagement] RLS ghost retry error:', retryErr);
              return;
            }
          }
          

          const selectedStoreId = get().selectedStoreId;
          const hasSelected = selectedStoreId ? stores.some((s) => s.id === selectedStoreId) : false;

          set({
            stores,
            selectedStoreId: hasSelected ? selectedStoreId : null,
          });

          
        } catch (error) {
          console.error('[storeManagement] Error loading stores:', error);
          set({ error: error?.message || 'Failed to load stores' });
        } finally {
          set({ isLoading: false });
        }
      },

      addStore: async (store) => {
        
        const user = useAuth.getState().user;
        if (!user) throw new Error('User not authenticated');

        const organizationId = useOrganization.getState().activeOrganizationId;
        if (!organizationId) throw new Error('No active organization selected');

        set({ isLoading: true, error: null });
        try {
          const newStore = {
            ...store,
            id: crypto.randomUUID(),
            organizationId,
            createdAt: new Date().toISOString(),
          };

          
          await saveStore(user.id, organizationId, newStore);

          
          set((state) => ({
            stores: [...state.stores, newStore],
          }));

          
        } catch (error) {
          console.error('[storeManagement] Error adding store:', error);
          set({ error: error?.message || 'Failed to add store' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      removeStore: async (id) => {
        const user = useAuth.getState().user;
        if (!user) throw new Error('User not authenticated');

        const organizationId = useOrganization.getState().activeOrganizationId;
        if (!organizationId) throw new Error('No active organization selected');

        set({ isLoading: true, error: null });
        try {
          await deleteStoreFromSupabase(user.id, organizationId, id);
          set((state) => ({
            stores: state.stores.filter((s) => s.id !== id),
            selectedStoreId: state.selectedStoreId === id ? null : state.selectedStoreId,
          }));
        } catch (error) {
          console.error('Error removing store:', error);
          set({ error: error?.message || 'Failed to remove store' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      updateStore: async (id, updates) => {
        const user = useAuth.getState().user;
        if (!user) throw new Error('User not authenticated');

        const organizationId = useOrganization.getState().activeOrganizationId;
        if (!organizationId) throw new Error('No active organization selected');

        set({ isLoading: true, error: null });
        try {
          await updateStoreInSupabase(user.id, organizationId, id, updates);
          set((state) => ({
            stores: state.stores.map((s) => (s.id === id ? { ...s, ...updates } : s)),
          }));
        } catch (error) {
          console.error('Error updating store:', error);
          set({ error: error?.message || 'Failed to update store' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      setSelectedStore: (id) => set({ selectedStoreId: id }),
      setViewMode: (mode) => set({ viewMode: mode }),

      clearStores: () => {
        
        set({ stores: [], selectedStoreId: null, viewMode: 'combined', isLoading: false, error: null });
      },
    }),
    {
      name: 'shopify-stores',
      partialize: (state) => ({
        stores: state.stores,
        selectedStoreId: state.selectedStoreId,
        viewMode: state.viewMode,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.isLoading = false;
      },
    }
  )
);
