# Guide de déploiement — GitHub → Supabase → Vercel

Architecture : **GitHub** (code) → **hébergeur Node.js compatible Express** (par exemple Railway ou Vercel) → **Supabase** (base PostgreSQL + authentification).

Cette archive utilise Express. Elle n'est pas directement déployable comme simple site statique Cloudflare Pages sans adapter/réécrire la couche API en Cloudflare Workers/Pages Functions.

```
championnat/
├─ api/index.js        API REST Express (auth, classement, stats, CRUD)
├─ public/index.html   Interface (HTML/CSS/JS, Fetch API)
├─ supabase/schema.sql Tables + données de démonstration (installation initiale uniquement)\n├─ supabase/auth-security.sql Quotas anti-abus (migration additive)
├─ vercel.json         Redirige /api/* vers la fonction Express
├─ package.json
└─ .env.example        Variables d'environnement (modèle)
```

## 0. Prérequis

- Comptes gratuits : [GitHub](https://github.com), [Supabase](https://supabase.com), [Vercel](https://vercel.com)
- Node.js 20+ et Git installés sur votre machine

## 1. Supabase — base de données

1. Sur supabase.com : **New project** → choisir un nom, un mot de passe de base de données (le conserver) et une région proche de vos utilisateurs.
2. Attendre la fin de la création du projet.
3. Menu **SQL Editor** → **New query** → coller tout le contenu de `supabase/schema.sql` → **Run**.
   Les tables, la sécurité RLS et les données de démonstration sont créées. **Ne réexécutez pas ce script sur une base de production déjà utilisée** : il s'agit du schéma initial et il contient des données de démonstration.
5. Dans une nouvelle requête SQL Editor, exécuter ensuite `supabase/auth-security.sql`. Cette migration ajoute uniquement la table de limitation des tentatives et sa fonction ; elle ne supprime aucune donnée existante.
4. Récupérer les clés dans **Project Settings → API** (ou **API Keys** selon la version de l'interface) :
   - **Project URL** → `SUPABASE_URL`
   - clé **anon / publishable** → `SUPABASE_ANON_KEY`
   - clé **service_role / secret** → `SUPABASE_SERVICE_ROLE_KEY`

> La clé `service_role` donne tous les droits sur la base. Elle ne doit jamais être publiée dans le code, sur GitHub ni dans le navigateur : elle reste uniquement dans les variables d'environnement.

## 2. Tester en local

```bash
cd championnat
cp .env.example .env      # puis remplir les 4 valeurs
npm install
npm run dev               # http://localhost:3000
```

Exécuter aussi la migration `supabase/auth-security.sql` avant le test d'inscription. Créer un compte via « S'inscrire » : les nouveaux comptes utilisent un code secret à 8 chiffres, sans e-mail de confirmation. Les anciens comptes conservent leur mot de passe existant.

## 3. Créer le compte administrateur

Les comptes créés depuis le site ont le rôle `user`. Pour promouvoir le vôtre, après vous être inscrit, exécuter dans le **SQL Editor** de Supabase :

```sql
update profiles set role='admin'
where id=(select id from auth.users where email='vous@exemple.com');
```

Déconnectez-vous puis reconnectez-vous : la section « Administration » apparaît.

## 4. GitHub — dépôt

1. Créer un dépôt vide sur github.com (**New repository**, sans README).
2. Dans le dossier du projet :

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<depot>.git
git push -u origin main
```

Vérifier que `.env` n'apparaît pas dans le dépôt : il est exclu par `.gitignore`. Ne jamais publier `SUPABASE_SERVICE_ROLE_KEY` ni `AUTH_RATE_LIMIT_SECRET`.

## 5. Déploiement sur Railway ou Vercel

Sur Railway, ajoutez les quatre variables dans **Variables** puis redéployez. Sur Vercel, suivez les étapes ci-dessous. Cloudflare Pages ne peut pas exécuter cette API Express telle quelle : une adaptation Workers/Pages Functions est nécessaire.

### Option A : interface web

1. Sur vercel.com : **Add New → Project** → **Import** le dépôt GitHub.
2. **Framework Preset** : `Other`. Laisser les commandes de build vides.
3. Déplier **Environment Variables** et ajouter :

| Nom | Valeur |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | clé anon / publishable |
| `SUPABASE_SERVICE_ROLE_KEY` | clé service_role / secret |\n| `AUTH_RATE_LIMIT_SECRET` | secret aléatoire long, distinct des clés Supabase |

4. Cliquer **Deploy**. Le site est disponible sur `https://<projet>.vercel.app`.

### Option B : ligne de commande

```bash
npm i -g vercel
vercel login
vercel                                   # premier déploiement (aperçu)
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add AUTH_RATE_LIMIT_SECRET production
vercel --prod                            # mise en production
```

## 6. Déploiement continu

Une fois le dépôt relié, chaque `git push` sur `main` redéploie automatiquement en production. Les autres branches et pull requests génèrent des URL d'aperçu.

```bash
git add . && git commit -m "Mon changement" && git push
```

## 7. Nom de domaine (optionnel)

Vercel → projet → **Settings → Domains** → ajouter le domaine, puis créer chez votre registrar l'enregistrement DNS indiqué (A ou CNAME). Le certificat HTTPS est automatique.

## 8. Vérifications après déploiement

- `https://<projet>.vercel.app/api/standings` renvoie du JSON.
- La page d'accueil affiche le classement et le calendrier.
- Inscription et connexion fonctionnent.
- En administrateur : saisir un résultat met à jour le classement et ajoute une notification. L'ajout d'un but ou d'un carton ajoute aussi une notification.

## 9. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `/api/...` renvoie 404 | `vercel.json` absent du dépôt | Vérifier qu'il est commité à la racine |
| Erreur « supabaseUrl is required » | Variables manquantes | Les ajouter dans Vercel, puis **Redeploy** |
| Classement vide | Schéma initial non installé ou tables manquantes | Vérifier les tables et relations dans Supabase ; ne pas rejouer aveuglément le script initial sur la production |\n| Erreur sur les tentatives de connexion | Migration anti-abus non exécutée | Exécuter `supabase/auth-security.sql` dans SQL Editor |
| Message « Réservé aux administrateurs » | Rôle `user` | Exécuter la requête de la section 3 |
| Déconnecté après un certain temps | Le jeton Supabase expire (1 h par défaut) | Se reconnecter ; la durée se règle dans Supabase → Authentication |
| Site lent après une longue inactivité | Démarrage à froid de la fonction, ou projet Supabase gratuit mis en pause | Relancer le projet depuis le tableau de bord Supabase |

## 10. Bonnes pratiques de sécurité

- Ne jamais commiter `.env` ni exposer la clé `service_role`.
- Si une clé a fuité, la régénérer dans Supabase puis mettre à jour les variables Vercel.
- Les tables ont la RLS activée sans politique : seules les routes de l'API (clé serveur) peuvent y accéder.
