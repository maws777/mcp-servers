# Spike 2 expliqué : se connecter depuis une app web installée sur iPhone

Code : `spikes/02-pwa-login/`. Suite du spike 1 (même pool Cognito, même
resource server).

## 1. La question

Le futur dashboard (repas du jour, objectifs, tendances, résumé IA) est un
site web statique que j'installe sur l'écran d'accueil de l'iPhone. Il doit se
connecter via Cognito comme claude.ai, mais depuis un navigateur sur iOS, ce
qui pose un problème connu :

- une app installée (« standalone ») qui navigue vers un autre domaine (la
  page de login Cognito) l'ouvre dans une fenêtre par-dessus l'app ;
- sur certaines versions d'iOS, la redirection de retour finissait dans
  Safari et pas dans l'app ;
- Safari et l'app installée **ne partagent pas leur stockage**. Le secret
  PKCE gardé au départ était introuvable au retour, et la connexion échouait.

Le spike vérifie que le login revient bien dans l'app et que la session tient.

## 2. Les outils

### PWA (Progressive Web App)

Un site web qui peut s'installer comme une app. Ce qu'il faut :

- un **manifest** (`manifest.webmanifest`) : nom, icônes, `start_url`, et
  surtout `display: standalone` (pas de barre d'adresse ni d'interface
  Safari) ;
- une **icône PNG** (`apple-touch-icon`), qu'iOS utilise sur l'écran
  d'accueil ;
- HTTPS.

Intérêt pratique : les apps installées sont exemptées de la règle de Safari
qui efface le stockage d'un site après 7 jours sans visite. Le refresh token
survit donc, et je reste connecté.

La page détecte le mode avec `matchMedia('(display-mode: standalone)')` (et
`navigator.standalone` sur iOS) et le note à chaque étape du journal.

### S3 (le stockage des fichiers)

Le bucket contient les fichiers du site. Il est **privé** : accès public
bloqué, ACL désactivées. Il n'est pas configuré en « site web S3 » : ce mode
exige un bucket public et ne fait pas de HTTPS.

### CloudFront (le CDN devant S3)

CloudFront sert le site en HTTPS depuis des serveurs proches des
utilisateurs. Trois points importants :

- **Origin Access Control (OAC)** : CloudFront signe ses requêtes vers S3, et
  la policy du bucket n'autorise que cette distribution précise
  (`AWS:SourceArn`). Un accès direct à S3 renvoie 403 (vérifié).
- **Response headers policy** : CloudFront ajoute des en-têtes de sécurité à
  chaque réponse (détail ci-dessous).
- **Gratuit** à cette échelle (1 To et 10 millions de requêtes par mois, sans
  limite dans le temps). Domaine `*.cloudfront.net` pour le spike. Le vrai
  dashboard aura un domaine custom avec un certificat ACM, qui doit être créé
  en **us-east-1** (exigence de CloudFront).

### Les en-têtes de sécurité, et la CSP

| En-tête | Ce qu'il fait |
|---|---|
| `Content-Security-Policy` | Liste blanche de ce que la page peut charger et contacter |
| `Strict-Transport-Security` | Le navigateur refuse ensuite tout accès en HTTP simple pendant un an |
| `X-Frame-Options: DENY` + `frame-ancestors 'none'` | La page ne peut pas être intégrée dans une iframe (clickjacking) |
| `X-Content-Type-Options: nosniff` | Le navigateur respecte le type annoncé (un fichier texte ne devient pas un script) |
| `Referrer-Policy: no-referrer` | Les URLs (qui peuvent contenir un code OAuth) ne fuient pas vers d'autres sites |

La **CSP** est la défense principale contre le **XSS**. Si un attaquant
arrivait à glisser du HTML dans une description de repas, le navigateur
refuserait d'exécuter un script qui ne vient pas d'un fichier de mon site :

- `script-src 'self'` : aucun script inline, aucun `eval`, aucun script
  externe ;
- `connect-src 'self' <domaine Cognito>` : même un script injecté ne pourrait
  pas envoyer les jetons vers un autre serveur ;
- `default-src 'none'` : tout le reste est interdit par défaut.

D'où le choix de mettre tout le JavaScript dans `app.js` (pas dans le HTML), et
la configuration dans un `config.js` généré par Terraform. En complément,
l'affichage passe uniquement par `textContent`, jamais `innerHTML` : une
valeur ne peut pas devenir du HTML.

### CORS

Par défaut, un navigateur interdit à une page d'appeler une API d'un autre
domaine. Le serveur doit l'autoriser via les en-têtes CORS. Le token endpoint
de Cognito répond bien `Access-Control-Allow-Origin: <mon site>` (vérifié).
Donc la page peut échanger le code elle-même, sans backend intermédiaire.

### Le client Cognito du dashboard

C'est un **client distinct** de celui de claude.ai :

- public (un navigateur ne peut pas garder de secret) + PKCE ;
- **seulement `food:read`** : un jeton volé dans le navigateur (XSS,
  téléphone perdu) peut lire mes repas, jamais en écrire ou en supprimer ;
- URL de retour et de déconnexion = uniquement l'URL du site ;
- rotation des refresh tokens.

## 3. Le déroulé (vérifié dans CloudTrail)

1. J'ouvre l'app depuis l'écran d'accueil (mode standalone).
2. « Se connecter » : la page génère le secret PKCE, le stocke dans
   `localStorage` et ouvre `/oauth2/authorize` chez Cognito.
3. Mot de passe (`login_POST`), puis code TOTP (`mfa_totp_POST`).
4. Cognito redirige vers mon site avec `?code=...`.
5. La page retrouve le secret dans `localStorage`, vérifie le `state`, et
   échange le code contre les jetons (`Token_POST`, `authorization_code` +
   `code_verifier` : 200).
6. « Rafraîchir » : nouveau jeton et nouveau refresh token
   (`Token_POST`, `refresh_token` : 200).

Que l'étape 5 ait réussi avec le `code_verifier` prouve que le retour s'est
fait dans un contexte qui voit le stockage du départ. Le piège iOS ne s'est pas
produit (iOS 18.7).

**CloudTrail** enregistre les étapes du login Cognito (pages et token
endpoint) avec les secrets masqués (`HIDDEN_DUE_TO_SECURITY_REASONS`). C'est
ce qui m'a permis de vérifier côté serveur sans voir le téléphone. C'est aussi
une bonne base pour la détection (pilier 3) : par exemple, des alertes sur une
rafale de `login_POST` en échec.

## 4. Questions d'entretien

**Pourquoi pas de backend pour le login ?** Le flow code + PKCE est fait pour
les clients publics, et Cognito autorise le CORS sur son token endpoint. Un
backend (« BFF ») qui garderait les jetons côté serveur dans un cookie
HttpOnly serait plus fort contre le XSS. Mais il ajoute un composant, et ici
la CSP stricte plus un jeton en lecture seule limitent déjà l'impact.

**Où stockes-tu les jetons, et pourquoi ?** Dans `localStorage` pour le
spike. Tout script de la page peut les lire, donc la vraie protection est la
CSP (aucun script tiers ni inline) et le scope `food:read`. C'est une décision
à documenter dans une ADR pour la vraie app.

**Comment as-tu vérifié que ça marchait ?** Le journal dans l'app (mode
d'affichage à chaque étape) et, côté serveur, les événements Cognito dans
CloudTrail : `Token_POST` avec `code_verifier` réussi, puis refresh réussi.
