-- Ligue : schéma Supabase (PostgreSQL). À exécuter dans SQL Editor.
create table profiles(id uuid primary key references auth.users(id) on delete cascade, name text not null, role text not null default 'user');
create table stadiums(id serial primary key, name text not null, city text, capacity int);
create table referees(id serial primary key, name text not null, country text);
create table teams(id serial primary key, name text not null, city text, coach text, stadium_id int references stadiums(id) on delete set null);
create table players(id serial primary key, name text not null, pos text, number int, team_id int references teams(id) on delete cascade);
create table matches(id serial primary key, home_id int not null references teams(id) on delete cascade, away_id int not null references teams(id) on delete cascade,
  date date not null, stadium_id int references stadiums(id) on delete set null, referee_id int references referees(id) on delete set null,
  hg int default 0, ag int default 0, played boolean default false);
create table events(id serial primary key, match_id int references matches(id) on delete cascade, player_id int references players(id) on delete cascade,
  type text check (type in ('goal','yellow','red')), minute int);
create table notifications(id serial primary key, text text not null, date timestamptz default now());

-- L'API utilise la clé service_role (qui contourne RLS) : on verrouille l'accès direct.
alter table profiles enable row level security; alter table stadiums enable row level security; alter table referees enable row level security;
alter table teams enable row level security; alter table players enable row level security; alter table matches enable row level security;
alter table events enable row level security; alter table notifications enable row level security;

-- Données de démonstration
insert into stadiums(name,city,capacity) values ('Stade du Port','Marseille',42000),('Parc Nord','Lille',38000),('Arena Rouge','Lyon',55000),('Stade des Alpes','Grenoble',30000);
insert into referees(name,country) values ('M. Lefèvre','France'),('A. Okafor','Nigeria'),('S. Duarte','Portugal');
insert into teams(name,city,coach,stadium_id) values ('Olympique Port','Marseille','R. Vidal',1),('Lille Nord FC','Lille','C. Moreau',2),('Lyon Rouge','Lyon','P. Bertin',3),('Alpes United','Grenoble','J. Faure',4);
insert into players(name,team_id,pos,number)
  select (array['Diallo','Marchand','Kone','Rivière'])[k]||' '||chr(64+t.id+k), t.id, (array['GK','DEF','MID','ATT'])[k], k+8 from teams t, generate_series(1,4) k;
insert into matches(home_id,away_id,date,stadium_id,referee_id,hg,ag,played)
  select a.id,b.id,current_date+(row_number() over (order by a.id,b.id)-9)::int,a.stadium_id,((a.id+b.id)%3)+1,
    case when row_number() over (order by a.id,b.id)<=9 then (a.id*b.id+row_number() over (order by a.id,b.id)::int)%4 else 0 end,
    case when row_number() over (order by a.id,b.id)<=9 then (a.id+b.id+row_number() over (order by a.id,b.id)::int)%3 else 0 end,
    row_number() over (order by a.id,b.id)<=9
  from teams a join teams b on a.id<>b.id;
insert into events(match_id,player_id,type,minute)
  select m.id,(select id from (select id,row_number() over (order by id) rn from players where team_id=m.home_id) p where rn=(g%3)+1),'goal',10+g*20
  from matches m cross join lateral generate_series(0,m.hg-1) g where m.played
  union all
  select m.id,(select id from (select id,row_number() over (order by id) rn from players where team_id=m.away_id) p where rn=(g%3)+2),'goal',25+g*18
  from matches m cross join lateral generate_series(0,m.ag-1) g where m.played;
insert into events(match_id,player_id,type,minute) select id,away_id*4-2,'yellow',55 from matches where played and (home_id+away_id)%2=1;
insert into notifications(text) values ('Bienvenue dans le championnat. Les résultats se mettent à jour en direct.');
-- Promouvoir un administrateur (après avoir créé votre compte sur le site) :
-- update profiles set role='admin' where id=(select id from auth.users where email='vous@exemple.com');
