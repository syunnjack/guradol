-- guradol.jp の投票と口コミ。
--
-- サイトは GitHub Pages の静的サイトなので、投稿の保存先として Supabase を使う。
-- ブラウザからは匿名キー（anon）で直接読み書きするため、守りは RLS だけが頼り。
-- 次の3つを必ず満たすこと。
--   1. 口コミは、承認したものしか読めない
--   2. 投稿されたものは必ず未承認から始まる（投稿者が承認済みにできない）
--   3. 投稿者は、自分の投稿を後から書き換えたり消したりできない
--
-- 実在の人物についての書き込みなので、公開前に運営が内容を確認する。
--
-- **darekore.jp とはテーブルを分ける。** 同じ Supabase を使うが、
-- スラッグが衝突しうるうえ、確認待ちの列も混ざると扱いにくい。

create table if not exists public.idol_votes (
    id          bigint generated always as identity primary key,
    slug        text        not null,
    voter_hash  text        not null,
    created_at  timestamptz not null default now(),

    -- 同じ人が同じ相手に何度も入れられないようにする。
    -- voter_hash はブラウザ側で作る識別子で、個人を特定するものではない。
    unique (slug, voter_hash)
);

create index if not exists idol_votes_slug_idx on public.idol_votes (slug);

create table if not exists public.idol_reviews (
    id          bigint generated always as identity primary key,
    slug        text        not null,
    nickname    text,
    body        text        not null,
    status      text        not null default 'pending',
    created_at  timestamptz not null default now(),
    reviewed_at timestamptz,

    constraint idol_reviews_status_check
        check (status in ('pending', 'approved', 'rejected')),
    constraint idol_reviews_body_length
        check (char_length(body) between 4 and 400),
    constraint idol_reviews_nickname_length
        check (nickname is null or char_length(nickname) <= 20)
);

create index if not exists idol_reviews_slug_idx
    on public.idol_reviews (slug) where status = 'approved';

create index if not exists idol_reviews_pending_idx
    on public.idol_reviews (created_at) where status = 'pending';

-- 承認済みの口コミの件数と、投票数をまとめて読むための眺め。
create or replace view public.idol_stats as
select
    slug,
    sum(votes)   as votes,
    sum(reviews) as reviews
from (
    select slug, count(*) as votes, 0 as reviews
      from public.idol_votes group by slug
    union all
    select slug, 0, count(*)
      from public.idol_reviews where status = 'approved' group by slug
) as combined
group by slug;

-- ここから RLS。
alter table public.idol_votes   enable row level security;
alter table public.idol_reviews enable row level security;

drop policy if exists "誰でも投票数を読める"        on public.idol_votes;
drop policy if exists "誰でも投票できる"            on public.idol_votes;
drop policy if exists "承認済みの口コミだけ読める"  on public.idol_reviews;
drop policy if exists "誰でも投稿できる"            on public.idol_reviews;

create policy "誰でも投票数を読める"
    on public.idol_votes for select
    to anon, authenticated
    using (true);

create policy "誰でも投票できる"
    on public.idol_votes for insert
    to anon, authenticated
    with check (char_length(slug) between 1 and 200
            and char_length(voter_hash) between 8 and 64);

create policy "承認済みの口コミだけ読める"
    on public.idol_reviews for select
    to anon, authenticated
    using (status = 'approved');

-- 投稿は必ず未承認から。status を指定して承認済みで入れることはできない。
create policy "誰でも投稿できる"
    on public.idol_reviews for insert
    to anon, authenticated
    with check (status = 'pending' and reviewed_at is null);

-- 更新と削除のポリシーは作らない。つまり anon は書き換えも削除もできない。

-- 運営が承認・却下するときに使う。Supabase の SQL Editor から呼ぶ。
create or replace function public.approve_idol_review(review_id bigint)
returns void language sql security definer set search_path = public as $$
    update public.idol_reviews
       set status = 'approved', reviewed_at = now()
     where id = review_id;
$$;

create or replace function public.reject_idol_review(review_id bigint)
returns void language sql security definer set search_path = public as $$
    update public.idol_reviews
       set status = 'rejected', reviewed_at = now()
     where id = review_id;
$$;

-- **PostgreSQL では関数の実行権限が既定で PUBLIC に付く。**
-- anon と authenticated から取り消すだけでは PUBLIC 経由で誰でも呼べてしまう。
-- darekore.jp で実際にこれを書き忘れ、匿名キーで承認関数を呼べる状態だった。
-- PUBLIC から取り消すこと。
revoke execute on function public.approve_idol_review(bigint) from public;
revoke execute on function public.reject_idol_review(bigint)  from public;
revoke execute on function public.approve_idol_review(bigint) from anon, authenticated;
revoke execute on function public.reject_idol_review(bigint)  from anon, authenticated;
