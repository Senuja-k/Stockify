-- Organizations and membership
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- Profiles for email lookup
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Ensure organizations.created_by is always set to auth.uid()
create or replace function public.set_organization_creator()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists set_organization_creator on public.organizations;
create trigger set_organization_creator
  before insert on public.organizations
  for each row execute function public.set_organization_creator();

-- Add organization_id to existing tables
alter table public.stores add column if not exists organization_id uuid references public.organizations(id);
alter table public.reports add column if not exists organization_id uuid references public.organizations(id);
alter table public.shopify_products add column if not exists organization_id uuid references public.organizations(id);
do $$
begin
  if to_regclass('public.shopify_product_metafields') is not null then
    alter table public.shopify_product_metafields add column if not exists organization_id uuid references public.organizations(id);
  end if;
end $$;
alter table public.shopify_store_sync_status add column if not exists organization_id uuid references public.organizations(id);
alter table public.shopify_stores add column if not exists organization_id uuid references public.organizations(id);

create index if not exists stores_org_idx on public.stores (organization_id);
create index if not exists reports_org_idx on public.reports (organization_id);
create index if not exists shopify_products_org_idx on public.shopify_products (organization_id);
do $$
begin
  if to_regclass('public.shopify_product_metafields') is not null then
    create index if not exists shopify_product_metafields_org_idx on public.shopify_product_metafields (organization_id);
  end if;
end $$;
create index if not exists shopify_store_sync_status_org_idx on public.shopify_store_sync_status (organization_id);
create index if not exists shopify_stores_org_idx on public.shopify_stores (organization_id);

-- RLS helpers
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

-- Enable RLS
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.reports enable row level security;
alter table public.shopify_products enable row level security;
do $$
begin
  if to_regclass('public.shopify_product_metafields') is not null then
    alter table public.shopify_product_metafields enable row level security;
  end if;
end $$;
alter table public.shopify_store_sync_status enable row level security;
alter table public.shopify_stores enable row level security;

-- Organization policies
drop policy if exists "org_select" on public.organizations;
create policy "org_select" on public.organizations
  for select using (public.is_org_member(id) or created_by = auth.uid());

drop policy if exists "org_insert" on public.organizations;
create policy "org_insert" on public.organizations
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "org_update_admin" on public.organizations;
create policy "org_update_admin" on public.organizations
  for update using (public.is_org_admin(id));

drop policy if exists "org_delete_admin" on public.organizations;
create policy "org_delete_admin" on public.organizations
  for delete using (public.is_org_admin(id));

-- Organization members policies
drop policy if exists "org_members_select" on public.organization_members;
create policy "org_members_select" on public.organization_members
  for select using (public.is_org_member(organization_id));

drop policy if exists "org_members_insert_admin" on public.organization_members;
create policy "org_members_insert_admin" on public.organization_members
  for insert to authenticated
  with check (
    public.is_org_admin(organization_id)
    or (
      user_id = auth.uid()
      and exists (
        select 1 from public.organizations o
        where o.id = organization_id and o.created_by = auth.uid()
      )
    )
  );

drop policy if exists "org_members_update_admin" on public.organization_members;
create policy "org_members_update_admin" on public.organization_members
  for update using (public.is_org_admin(organization_id));

drop policy if exists "org_members_delete_admin" on public.organization_members;
create policy "org_members_delete_admin" on public.organization_members
  for delete using (public.is_org_admin(organization_id));

-- Profiles policies (required for invite by email)
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = id);

-- Data access policies (organization scoped)
drop policy if exists "stores_org_select" on public.stores;
create policy "stores_org_select" on public.stores
  for select using (public.is_org_member(organization_id));
drop policy if exists "stores_org_insert" on public.stores;
create policy "stores_org_insert" on public.stores
  for insert with check (public.is_org_member(organization_id));
drop policy if exists "stores_org_update" on public.stores;
create policy "stores_org_update" on public.stores
  for update using (public.is_org_member(organization_id));
drop policy if exists "stores_org_delete" on public.stores;
create policy "stores_org_delete" on public.stores
  for delete using (public.is_org_member(organization_id));

drop policy if exists "reports_org_select" on public.reports;
create policy "reports_org_select" on public.reports
  for select using (public.is_org_member(organization_id));
drop policy if exists "reports_org_insert" on public.reports;
create policy "reports_org_insert" on public.reports
  for insert with check (public.is_org_member(organization_id));
drop policy if exists "reports_org_update" on public.reports;
create policy "reports_org_update" on public.reports
  for update using (public.is_org_member(organization_id));
drop policy if exists "reports_org_delete" on public.reports;
create policy "reports_org_delete" on public.reports
  for delete using (public.is_org_member(organization_id));

drop policy if exists "products_org_select" on public.shopify_products;
create policy "products_org_select" on public.shopify_products
  for select using (public.is_org_member(organization_id));
drop policy if exists "products_org_insert" on public.shopify_products;
create policy "products_org_insert" on public.shopify_products
  for insert with check (public.is_org_member(organization_id));
drop policy if exists "products_org_update" on public.shopify_products;
create policy "products_org_update" on public.shopify_products
  for update using (public.is_org_member(organization_id));
drop policy if exists "products_org_delete" on public.shopify_products;
create policy "products_org_delete" on public.shopify_products
  for delete using (public.is_org_member(organization_id));

do $$
begin
  if to_regclass('public.shopify_product_metafields') is not null then
    drop policy if exists "metafields_org_select" on public.shopify_product_metafields;
    create policy "metafields_org_select" on public.shopify_product_metafields
      for select using (public.is_org_member(organization_id));
    drop policy if exists "metafields_org_insert" on public.shopify_product_metafields;
    create policy "metafields_org_insert" on public.shopify_product_metafields
      for insert with check (public.is_org_member(organization_id));
    drop policy if exists "metafields_org_update" on public.shopify_product_metafields;
    create policy "metafields_org_update" on public.shopify_product_metafields
      for update using (public.is_org_member(organization_id));
    drop policy if exists "metafields_org_delete" on public.shopify_product_metafields;
    create policy "metafields_org_delete" on public.shopify_product_metafields
      for delete using (public.is_org_member(organization_id));
  end if;
end $$;

drop policy if exists "sync_org_select" on public.shopify_store_sync_status;
create policy "sync_org_select" on public.shopify_store_sync_status
  for select using (public.is_org_member(organization_id));
drop policy if exists "sync_org_insert" on public.shopify_store_sync_status;
create policy "sync_org_insert" on public.shopify_store_sync_status
  for insert with check (public.is_org_member(organization_id));
drop policy if exists "sync_org_update" on public.shopify_store_sync_status;
create policy "sync_org_update" on public.shopify_store_sync_status
  for update using (public.is_org_member(organization_id));
drop policy if exists "sync_org_delete" on public.shopify_store_sync_status;
create policy "sync_org_delete" on public.shopify_store_sync_status
  for delete using (public.is_org_member(organization_id));

drop policy if exists "shopify_stores_org_select" on public.shopify_stores;
create policy "shopify_stores_org_select" on public.shopify_stores
  for select using (public.is_org_member(organization_id));
drop policy if exists "shopify_stores_org_insert" on public.shopify_stores;
create policy "shopify_stores_org_insert" on public.shopify_stores
  for insert with check (public.is_org_member(organization_id));
drop policy if exists "shopify_stores_org_update" on public.shopify_stores;
create policy "shopify_stores_org_update" on public.shopify_stores
  for update using (public.is_org_member(organization_id));
drop policy if exists "shopify_stores_org_delete" on public.shopify_stores;
create policy "shopify_stores_org_delete" on public.shopify_stores
  for delete using (public.is_org_member(organization_id));
