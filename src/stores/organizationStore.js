import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAuth } from '@/stores/authStore.jsx';
import {
  addOrganizationMemberByEmail,
  createOrganizationForUser,
  deleteOrganization as deleteOrganizationFromSupabase,
  getOrganizationMembers,
  getOrganizationsForUser,
  removeOrganizationMember,
  updateOrganizationMemberRole,
} from '@/lib/supabase-utils';

export const useOrganization = create()(
  persist(
    (set, get) => ({
      organizations: [],
      activeOrganizationId: null,
      members: [],
      isLoading: false,
      error: null,

      loadOrganizations: async (options = {}) => {
        const { force = false } = options;

        if (get().isLoading && !force) {
          
          return;
        }

        const { isAuthenticated, user } = useAuth.getState();
        if (!isAuthenticated) {
          
          set({ organizations: [], activeOrganizationId: null, members: [], isLoading: false, error: null });
          return;
        }

        set({ isLoading: true, error: null });

        try {
          if (!user) {
            
            return;
          }

          let organizations = await getOrganizationsForUser(user.id);
          if (organizations === null) {
            return;
          }

          const existingOrgs = get().organizations || [];
          if (organizations.length === 0 && existingOrgs.length > 0) {
            return;
          }

          if (organizations.length === 0) {
            
            try {
              const defaultOrg = await createOrganizationForUser(user.id, 'My Organization');
              organizations = [defaultOrg];
              
            } catch (createError) {
              console.error('[loadOrganizations] Failed to create default organization:', createError);
            }
          }

          let activeOrganizationId = get().activeOrganizationId;
          if (!activeOrganizationId || !organizations.find((org) => org.id === activeOrganizationId)) {
            activeOrganizationId = organizations[0]?.id || null;
          }

          set({ organizations, activeOrganizationId });

          if (activeOrganizationId) {
            const { useStoreManagement } = await import('./storeManagement');
            useStoreManagement.getState().loadStores({ organizationId: activeOrganizationId, force: true });
          }
        } catch (error) {
          console.error('Error loading organizations:', error);
          set({ error: error?.message || 'Failed to load organizations' });
        } finally {
          set({ isLoading: false });
        }
      },

      setActiveOrganization: async (organizationId) => {
        const currentOrgId = get().activeOrganizationId;
        console.log('[organizationStore] setActiveOrganization called', { currentOrgId, organizationId });
        set({ activeOrganizationId: organizationId });

        // The Index page will detect the org change and trigger a reload
        // (sync-guarded via requestReload in Index.jsx).
        // Load stores eagerly so data is ready after the reload.
        if (currentOrgId !== organizationId) {
          try {
            const { useStoreManagement } = await import('./storeManagement');
            if (organizationId) {
              useStoreManagement.getState().loadStores({ organizationId, force: true });
            } else {
              useStoreManagement.getState().clearStores();
            }
          } catch (e) {
            console.warn('[organizationStore] failed to pre-load stores for new org', e);
          }
        }
      },

      createOrganization: async (name) => {
        if (!name.trim()) throw new Error('Organization name is required');

        set({ isLoading: true, error: null });
        try {
          const { user } = useAuth.getState();
          if (!user) throw new Error('User not authenticated');

          const organization = await createOrganizationForUser(user.id, name.trim());
          const organizations = [...get().organizations, organization];

          set({ organizations, activeOrganizationId: organization.id });

          const { useStoreManagement } = await import('./storeManagement');
          useStoreManagement.getState().loadStores({ organizationId: organization.id, force: true });
        } catch (error) {
          set({ error: error?.message || 'Failed to create organization' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      loadMembers: async (organizationId) => {
        set({ isLoading: true, error: null });
        try {
          const members = await getOrganizationMembers(organizationId);
          set({ members });
        } catch (error) {
          console.error('Error loading organization members:', error);
          set({ error: error?.message || 'Failed to load members' });
        } finally {
          set({ isLoading: false });
        }
      },

      addMemberByEmail: async (organizationId, email, role) => {
        set({ isLoading: true, error: null });
        try {
          await addOrganizationMemberByEmail(organizationId, email, role);
          const members = await getOrganizationMembers(organizationId);
          set({ members });
        } catch (error) {
          set({ error: error?.message || 'Failed to add member' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      updateMemberRole: async (organizationId, userId, role) => {
        set({ isLoading: true, error: null });
        try {
          await updateOrganizationMemberRole(organizationId, userId, role);
          const members = await getOrganizationMembers(organizationId);
          set({ members });
        } catch (error) {
          set({ error: error?.message || 'Failed to update member' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      removeMember: async (organizationId, userId) => {
        set({ isLoading: true, error: null });
        try {
          await removeOrganizationMember(organizationId, userId);
          const members = await getOrganizationMembers(organizationId);
          set({ members });
        } catch (error) {
          set({ error: error?.message || 'Failed to remove member' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      deleteOrganization: async (organizationId) => {
        const { user } = useAuth.getState();
        if (!user) throw new Error('User not authenticated');

        set({ isLoading: true, error: null });
        try {
          await deleteOrganizationFromSupabase(user.id, organizationId);

          const orgs = get().organizations.filter((org) => org.id !== organizationId);
          const currentActiveId = get().activeOrganizationId;
          const newActiveId = currentActiveId === organizationId ? (orgs[0]?.id || null) : currentActiveId;

          set({
            organizations: orgs,
            activeOrganizationId: newActiveId,
            members: currentActiveId === organizationId ? [] : get().members,
          });

          const { useStoreManagement } = await import('./storeManagement');
          if (newActiveId) {
            useStoreManagement.getState().loadStores({ organizationId: newActiveId, force: true });
          } else {
            useStoreManagement.getState().clearStores();
          }
        } catch (error) {
          set({ error: error?.message || 'Failed to delete organization' });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },

      clearOrganizations: () => {
        set({ organizations: [], activeOrganizationId: null, members: [], isLoading: false, error: null });
      },
    }),
    {
      name: 'organization-state',
      partialize: (state) => ({
        organizations: state.organizations,
        activeOrganizationId: state.activeOrganizationId,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.isLoading = false;
      },
    }
  )
);
