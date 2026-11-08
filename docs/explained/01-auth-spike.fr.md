# Spike 1 expliqué : comment claude.ai se connecte à mon serveur MCP

Notes personnelles pour comprendre et expliquer en entretien ce que fait le
spike 1. Code : `spikes/01-claude-auth/` et `infra/staging/shared/`.

## 1. Le problème à résoudre

Je veux un serveur MCP (des outils que Claude appelle : « logue ce repas »,
« résumé du jour ») accessible sur Internet, que j'utilise depuis claude.ai.
Il stocke des données de santé, donc :

- seul moi doit pouvoir l'appeler ;
- claude.ai ne doit jamais connaître mon mot de passe ;
- le serveur doit savoir *qui* appelle, de façon fiable, pour ne lire que mes
  données.

La réponse standard est **OAuth** : claude.ai obtient un **jeton d'accès**
(access token) en mon nom, après que je me suis connecté sur une page qui
n'appartient pas à claude.ai, et l'envoie à chaque appel. Le serveur vérifie
le jeton.

Le spike vérifie que cette chaîne marche avec les briques choisies, avant de
construire l'app dessus. C'est un test jetable : s'il échoue, on change le
design de l'auth, pas 3 000 lignes de code.

## 2. Les trois rôles OAuth

OAuth sépare trois acteurs. Les retenir permet d'expliquer tout le reste :

| Rôle OAuth | Chez nous | Ce qu'il fait |
|---|---|---|
| **Client** | claude.ai | Veut appeler l'API en mon nom. Ne voit jamais mon mot de passe. |
| **Serveur d'autorisation** | Amazon Cognito | Me connecte (mot de passe + MFA) et délivre les jetons. |
| **Serveur de ressources** | Ma Lambda MCP | Reçoit les appels avec le jeton, le vérifie, répond. |

L'intérêt de séparer : le serveur de ressources ne gère aucun mot de passe. Il
vérifie seulement une signature. Et le client ne reçoit qu'un jeton limité
(durée d'une heure, permissions précises), pas mes identifiants.

## 3. Chaque outil utilisé

### Amazon Cognito (user pool)

Un **user pool** est un annuaire d'utilisateurs géré par AWS, qui sait aussi
jouer le rôle de serveur d'autorisation OAuth. Ce que j'y ai configuré :

- **Connexion par email, pas d'inscription libre** (`allow_admin_create_user_only`) :
  personne sur Internet ne peut se créer un compte et obtenir un jeton. Je crée
  les comptes moi-même.
- **MFA obligatoire par application TOTP** (Google Authenticator, etc.). Pas
  par SMS : payant et plus faible (SIM swapping).
- **Mot de passe de 14 caractères minimum**, récupération par email vérifié.
- **`deletion_protection` + `prevent_destroy`** : le pool contient les
  comptes, le supprimer par erreur casserait la connexion à toutes les apps.
- **Tier Essentials** : gratuit jusqu'à 10 000 utilisateurs actifs par mois
  (sans limite dans le temps). Choisi plutôt que Lite pour pouvoir
  personnaliser les access tokens plus tard (voir § 6).

Le pool est **partagé** par toutes mes futures apps MCP en staging (ADR 0012) :
je me connecte une fois, et chaque app a ses propres permissions dedans. C'est
pour ça qu'il vit dans sa propre stack Terraform (`infra/staging/shared`), qui
reste, alors que le spike sera détruit.

### Le domaine de connexion (managed login)

Les pages de connexion (« managed login ») et les endpoints OAuth
(`/oauth2/authorize`, `/oauth2/token`) sont servis par Cognito sur un domaine
`michaelteplov-mcp-staging.auth.eu-west-3.amazoncognito.com`. Gratuit, pas de
certificat à gérer. On pourra passer à `auth.staging.lab.michaelteplov.com`
plus tard.

### Resource server et scopes

Un **resource server**, dans Cognito, déclare « une API qui accepte les jetons
de ce pool », avec ses **scopes** (permissions nommées). Ici : identifiant
`mcp-food`, scopes `food:read` et `food:write`. Cognito les préfixe :
`mcp-food/food:read`.

Le préfixe est ce qui isole les apps : un jeton émis pour une autre app du même
pool n'aura pas `mcp-food/...`, donc mon serveur food le refusera.

Lire et écrire sont séparés pour le futur dashboard web : il n'aura que
`food:read`, donc un jeton volé dans le navigateur ne pourra rien écrire.

### App client (le client pré-enregistré)

Un **app client** est la fiche d'identité d'une application autorisée à
demander des jetons. Celui de claude.ai :

- **Public, sans secret.** claude.ai est un tiers : lui donner un secret ne
  protégerait rien de plus que PKCE (ci-dessous).
- **Flow `code` uniquement** (authorization code). Le flow « implicit », où le
  jeton revient directement dans l'URL, est interdit par OAuth 2.1.
- **Une seule URL de retour autorisée** : `https://claude.ai/api/mcp/auth_callback`.
  Cognito refuse de renvoyer le code ailleurs, donc un attaquant ne peut pas
  fabriquer un lien de connexion qui lui envoie mon code.
- **Pas de connexion directe par API** avec login/mot de passe : seulement les
  pages managed login (qui font la MFA) et le renouvellement par refresh token.
- **Durées** : access token 1 h, refresh token 30 jours, révocation activée.

Pourquoi « pré-enregistré » : la spec MCP prévoit que le client s'enregistre
tout seul (Client ID Metadata Documents, ou Dynamic Client Registration).
Cognito ne supporte ni l'un ni l'autre (vérifié le 2026-10-16). Donc je crée le
client moi-même et je colle son ID dans claude.ai (« Use your own OAuth
client »). La spec MCP autorise explicitement ce mode.

### PKCE

**PKCE** (Proof Key for Code Exchange) protège le code d'autorisation. Au
début, claude.ai invente un secret aléatoire (`code_verifier`), en envoie
l'empreinte SHA-256 (`code_challenge`) à Cognito, et garde le secret. À la fin,
pour échanger le code contre un jeton, il doit présenter le secret d'origine.
Quelqu'un qui intercepte le code (dans une URL, un log) ne peut pas l'utiliser
sans le secret. C'est ce qui remplace le « client secret » pour les clients
publics.

### Les jetons : JWT, signature, JWKS

L'access token de Cognito est un **JWT** : trois parties en base64 (en-tête,
contenu, signature). Le contenu contient notamment :

- `sub` : l'identifiant unique et permanent de l'utilisateur ;
- `iss` : qui l'a émis (l'URL du pool) ;
- `exp` : expiration ;
- `token_use` : `access` (et pas `id`) ;
- `client_id` : l'app client qui l'a demandé ;
- `scope` : les permissions accordées.

Cognito signe le jeton avec sa **clé privée**. Il publie les **clés
publiques** correspondantes à une URL publique (le **JWKS**). Ma Lambda
télécharge le JWKS une fois, puis peut vérifier n'importe quel jeton
localement, sans appeler Cognito à chaque requête. Si quelqu'un modifie un seul
caractère du contenu (pour changer le `sub`, par exemple), la signature ne
correspond plus.

### Ce que vérifie ma Lambda (`aws-jwt-verify`)

`aws-jwt-verify` est la librairie officielle d'AWS pour ça. Pour chaque appel :

1. **Signature** valide avec les clés du pool → le jeton vient bien de mon pool.
2. **`iss`** = mon pool → un jeton d'un autre pool Cognito (n'importe quel
   client AWS peut en créer un) est refusé.
3. **`exp`** dans le futur → les jetons expirés sont refusés.
4. **`token_use = access`** → un ID token (fait pour l'app cliente, pas pour
   les API) est refusé.
5. **`client_id`** dans ma liste et **`scope`** contient `mcp-food/food:read`.

Le point 5 compense une particularité de Cognito : ses access tokens n'ont
**pas de claim `aud`** (audience, « pour quel serveur ce jeton est fait »). La
spec MCP exige que le serveur vérifie que le jeton lui est destiné (sinon, un
jeton obtenu pour un autre service pourrait être rejoué chez moi). Avec
Cognito, c'est la combinaison `client_id` + scope préfixé par mon resource
server qui joue ce rôle.

Ensuite, l'identité de l'utilisateur (`sub`) est **prise dans le jeton
vérifié, jamais dans les arguments de l'outil**. Si Claude (ou une injection de
prompt) passait `user_id: "quelqu'un d'autre"` à un outil, ça n'aurait aucun
effet : le serveur n'a pas de paramètre pour ça.

### La découverte : RFC 9728 et le header `WWW-Authenticate`

Comment claude.ai sait-il qu'il faut aller chez Cognito ? Par un mécanisme
standard en deux sauts :

1. claude.ai appelle `POST /mcp` sans jeton. Ma Lambda répond **401** avec :
   `WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/oauth-protected-resource/mcp", scope="..."`
2. claude.ai lit ce document (**Protected Resource Metadata, RFC 9728**), qui
   dit : `authorization_servers: ["https://cognito-idp.eu-west-3.amazonaws.com/<pool>"]`.
3. claude.ai va chercher la configuration de Cognito. La spec MCP lui impose
   d'essayer trois URLs. Cognito ne publie que celle d'OpenID Connect
   (`<issuer>/.well-known/openid-configuration`), qui est la troisième de la
   liste. Ça devrait passer, **c'est l'un des points que le spike teste**.
4. Il y trouve l'URL de la page de connexion et celle du token.

Rien n'est codé en dur côté claude.ai : je lui donne juste l'URL du serveur et
l'ID du client.

### Le paramètre `resource` (RFC 8707)

La spec MCP oblige le client à envoyer `resource=https://.../mcp` à Cognito
(« ce jeton est pour ce serveur »). Cognito ne s'en sert pas pour mettre une
audience dans le jeton. **Deuxième point testé** : est-ce que Cognito l'ignore
gentiment ou refuse la requête ?

### AWS Lambda

Du code exécuté à la demande : pas de serveur allumé en permanence, facturé à
la milliseconde. Une invocation = une requête HTTP. Choix techniques :

- **Node.js 22, arm64** (processeurs Graviton, environ 20 % moins cher).
- **Code empaqueté par esbuild** : tout le TypeScript et ses dépendances
  regroupés en un seul fichier JavaScript, zippé par Terraform.
- Le vérificateur de jetons est créé **hors du handler** : AWS réutilise le
  même conteneur pour les requêtes suivantes, donc le JWKS téléchargé reste en
  cache.

Pour le vrai serveur, on passera à une image conteneur (avec le Lambda Web
Adapter) pour pouvoir la faire tourner aussi sur ECS Fargate. Le spike reste
en zip : on teste l'auth, pas le packaging.

### Le SDK MCP officiel (v2) et les deux « ères » du protocole

La spec MCP actuelle (2026-07-28) a supprimé les sessions : chaque requête
porte sa version de protocole et les infos du client dans un champ `_meta`.
C'est idéal pour Lambda, où rien ne survit entre deux requêtes. Les clients
plus anciens (spec 2025-11-25 et avant) commencent par un échange
`initialize`.

`createMcpHandler` du SDK sert **les deux** sur le même endpoint, sans état :
pour chaque requête, il crée un serveur neuf avec mes outils. J'ai testé les
deux en local avant de déployer (`initialize`/`tools/call` en mode ancien,
`server/discover`/`tools/list`/`tools/call` en mode 2026-07-28).

Le SDK ne vérifie pas les jetons lui-même : c'est mon code qui le fait avant,
puis passe le résultat (`authInfo`) au SDK.

Zod décrit les entrées des outils (ici `whoami` n'en prend pas). Dans le vrai
serveur, c'est Zod qui refusera un repas à 50 000 kcal.

### API Gateway (HTTP API)

L'adresse HTTPS publique devant la Lambda. Elle gère TLS, transforme la
requête HTTP en événement Lambda, et applique le **rate limiting** : au-delà
de 10 requêtes/s (pointes à 20), elle répond 429 elle-même, sans réveiller ni
facturer la Lambda. Seules trois routes existent (`/mcp` et les deux URLs de
metadata) : toute autre URL reçoit un 404 d'API Gateway, sans invoquer la
Lambda.

Le WAF ne peut pas se brancher sur une HTTP API (seulement REST API, ALB,
CloudFront), d'où ce throttling comme limite de débit.

### IAM : rôle d'exécution et permissions boundary

La Lambda tourne avec un **rôle IAM** qui ne peut qu'écrire ses propres logs.
Ce rôle :

- vit sous le chemin `/mcp/` et porte la **permissions boundary**
  `platform/mcp-workload-boundary` du landing zone (ADR 0013). Une boundary est
  un plafond : même si on attachait `AdministratorAccess` au rôle, il ne
  pourrait faire que ce que la boundary autorise (logs, tables `mcp-*`,
  Bedrock) ;
- est construit exactement comme le rôle CI `mcp-ci-apply` l'exigera, donc la
  stack pourra passer en CI sans changement.

`aws_lambda_permission` autorise API Gateway (cette API-là seulement) à
invoquer la fonction.

### CloudWatch Logs

Le groupe de logs est créé par Terraform avec une **rétention de 14 jours**
(par défaut, Lambda crée un groupe qui garde tout indéfiniment et coûte de plus
en plus). Chaque requête logue le chemin, la présence d'un jeton, le résultat
de la vérification et le `sub`, **jamais le jeton** (c'est un mot de passe
valable une heure).

### Terraform : deux stacks, state dans staging

- `infra/staging/shared` : le pool et le domaine (permanents).
- `spikes/01-claude-auth/infra` : tout le reste (détruit après le spike).

Les deux states sont dans le bucket `mcp-tfstate-<compte>` du compte staging,
créé par le landing zone. Le nom du bucket contient l'ID du compte, donc il
est dans `backend.hcl` (non commité) plutôt que dans le code public.
`allowed_account_ids` empêche Terraform d'agir sur un autre compte par erreur
(mauvais profil). En local j'utilise le profil `staging-admin` (Identity
Center, MFA). Plus tard, la CI utilisera les rôles OIDC.

## 4. Le déroulé complet, dans l'ordre

1. Je colle l'URL du serveur et l'ID du client dans claude.ai.
2. claude.ai → `POST /mcp` sans jeton → **401** + `WWW-Authenticate`.
3. claude.ai → `GET /.well-known/oauth-protected-resource/mcp` → l'adresse de Cognito.
4. claude.ai → configuration OpenID de Cognito → endpoints authorize et token.
5. claude.ai génère `code_verifier` + `code_challenge`, m'ouvre la page
   Cognito `/oauth2/authorize?client_id=...&code_challenge=...&resource=...&scope=...`.
6. Je me connecte : email, mot de passe, code TOTP.
7. Cognito redirige vers `https://claude.ai/api/mcp/auth_callback?code=...`.
8. Le serveur de claude.ai échange le code + `code_verifier` contre un access
   token (1 h) et un refresh token (30 j).
9. claude.ai → `POST /mcp` avec `Authorization: Bearer <jeton>`.
10. La Lambda vérifie le jeton (signature, iss, exp, token_use, client_id,
    scope) → passe la requête au SDK MCP avec le `sub`.
11. Claude appelle `whoami` → reçoit mon `sub`. Ça marche.
12. Une heure plus tard, claude.ai utilise le refresh token, sans me
    redemander de me connecter.

## 5. Ce que le spike doit prouver (et les risques connus)

| Question | Comment on le saura |
|---|---|
| claude.ai trouve-t-il Cognito via la discovery OpenID ? | La page Cognito s'ouvre |
| Cognito accepte-t-il le paramètre `resource` ? | Pas d'erreur `invalid_request` sur la page |
| Les scopes demandés (préfixés) sont-ils acceptés ? | Pas d'erreur `invalid_scope` |
| La validation sans `aud` fonctionne-t-elle ? | Log `"auth","result":"ok"` |
| L'outil reçoit-il le bon `sub` ? | `whoami` renvoie mon `sub` |
| Le refresh marche-t-il ? | Toujours connecté le lendemain |

**Première trouvaille (2026-11-08, avant même le test claude.ai).** La
configuration OpenID de Cognito ne contient pas `code_challenge_methods_supported`.
Or la spec MCP dit : si ce champ est absent, le client **doit refuser** de
continuer (il ne peut pas savoir si le serveur fait du PKCE). Cognito supporte
bien PKCE S256, il ne l'annonce juste pas.

- **Plan A** (`as_metadata_mode = "cognito"`) : on pointe vers Cognito et on
  regarde si claude.ai est tolérant.
- **Plan B** (`as_metadata_mode = "shim"`) : mon serveur publie sa propre
  metadata RFC 8414, avec les mêmes endpoints Cognito plus
  `code_challenge_methods_supported: ["S256"]`, et la metadata RFC 9728 pointe
  vers elle. Les jetons viennent toujours de Cognito et sont vérifiés pareil.
  C'est un « adaptateur de metadata » : on corrige une annonce incomplète sans
  remplacer le serveur d'autorisation.

**Deuxième trouvaille : Cognito gère le paramètre `resource` (RFC 8707).**
Avec un resource server nommé `mcp-food`, une requête `/oauth2/authorize`
contenant `resource=https://.../mcp` est refusée (`invalid_request` : les
scopes demandés doivent appartenir à la ressource demandée). Cognito fait du
« resource binding » : il n'accorde que les scopes du resource server dont
l'identifiant est **exactement** l'URL demandée. Correction : l'identifiant du
resource server devient l'URL du serveur MCP, et les scopes deviennent
`https://.../mcp/food:read`. Conséquence attendue : un claim `aud` dans le
jeton, que la Lambda vérifie s'il est présent (à confirmer avec un vrai jeton).
Sans ce test au `curl`, l'échec serait arrivé pendant la connexion depuis
claude.ai, avec un message bien moins clair.

Au passage : la spec exige la **rotation des refresh tokens** pour les clients
publics (chaque refresh renvoie un nouveau refresh token et invalide l'ancien).
Activée sur le client (fonction du tier Essentials).

Je peux vérifier moi-même une partie avant le vrai test (metadata, 401,
contenu de la configuration OpenID de Cognito, réaction de `/oauth2/authorize`
au paramètre `resource`). La connexion complète demande mon mot de passe et mon
téléphone : elle se fait à la main.

### Résultat (2026-11-08) : ça marche

claude.ai s'est connecté, `whoami` a renvoyé mon `sub`. Ce que les logs ont
montré :

- claude.ai a **toléré** l'absence de `code_challenge_methods_supported` : le
  plan B n'a pas servi (gardé pour un client plus strict).
- **Le jeton contient un `aud`** égal à l'URL du serveur, grâce au resource
  binding. Le « Cognito n'a pas d'`aud` » du design initial ne s'applique plus
  quand le client envoie `resource` : le vrai serveur exigera `aud`.
- claude.ai sonde d'abord sans jeton en protocole 2025-11-25, puis parle
  **2026-07-28** une fois authentifié. Le SDK v2 a servi les deux.
- Reste à vérifier : le renouvellement du jeton après 1 h.

## 6. Questions d'entretien probables

**Raconte un problème que tu as trouvé grâce au spike.** Le paramètre
`resource` : la spec MCP oblige le client à l'envoyer, et Cognito, qui le
supporte, refusait la connexion parce que mon resource server s'appelait
`mcp-food` au lieu de l'URL du serveur. Je l'ai trouvé au `curl` avant le
premier test réel, corrigé, et la correction a apporté un bonus : un vrai
`aud` dans les jetons.

**Pourquoi Cognito et pas Auth0/Keycloak ?** Tout reste dans AWS, dans mon
organisation, gratuit à cette échelle, géré (pas de serveur Keycloak à
patcher). Le prix : pas d'enregistrement dynamique de clients (je
pré-enregistre le client) et une découverte OpenID incomplète (pas d'annonce
PKCE), que claude.ai tolère et que je sais contourner (plan B).

**Comment ton serveur sait-il que le jeton lui est destiné ?** Trois
vérifications : `aud` égal à l'URL du serveur (Cognito le met grâce au
resource binding RFC 8707), scope préfixé par cette même URL, et `client_id`
dans une liste blanche. Sans `resource` dans la requête, Cognito ne met pas
d'`aud`, d'où les deux autres vérifications en plus.

**Pourquoi un client public sans secret ?** Le secret serait stocké chez un
tiers (claude.ai) : il n'authentifierait pas grand-chose. PKCE protège
l'échange du code, et l'URL de retour est verrouillée.

**Où est l'identité de l'utilisateur dans tes outils ?** Uniquement dans le
`sub` du jeton vérifié, capturé par le code serveur. Jamais un argument
d'outil. C'est ce qui empêche un modèle manipulé (prompt injection) d'agir sur
les données d'un autre utilisateur.

**Pourquoi Lambda + HTTP API pour un serveur MCP ?** La version actuelle de MCP
est sans état, donc chaque requête est indépendante : exactement le modèle de
Lambda. Coût quasi nul pour un usage personnel, pas de serveur toujours allumé.
Limite : pas de flux longs (SSE) à travers une HTTP API, ce dont mes outils
n'ont pas besoin.

**Comment limites-tu les abus ?** Pas d'inscription publique, MFA, jetons
courts, throttling API Gateway, routes explicites (le reste n'invoque même pas
la Lambda), rôle Lambda minimal sous une permissions boundary.
