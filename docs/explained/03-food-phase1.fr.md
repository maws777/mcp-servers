# Phase 1 expliquée : le journal alimentaire en production (staging)

Code : `packages/shared/`, `apps/food/`. Design : `docs/design/food-v1.md`.
Ce qui est nouveau par rapport aux spikes est expliqué ici ; l'auth elle-même
est dans `01-auth-spike.fr.md`.

## 1. Ce qui tourne

```
claude.ai ──> food.mcp.staging.lab.michaelteplov.com   (DNS : compte network)
                │  certificat TLS ACM, TLS 1.2 minimum
              API Gateway HTTP API   (3 routes, 10 req/s)
                │
              Lambda mcp-food-staging   (Node 22, ARM, 512 Mo)
                │  rôle IAM : cette table seulement
              DynamoDB mcp-food-staging
```

Cinq outils : `log_food`, `list_entries`, `update_entry`, `delete_entry`,
`daily_summary`.

## 2. Les nouveaux morceaux

### Domaine custom, certificat ACM, enregistrements alias

- **ACM** (AWS Certificate Manager) délivre gratuitement le certificat TLS de
  `food.mcp.staging.lab.michaelteplov.com`. Pour prouver que je contrôle le
  nom, ACM demande un enregistrement DNS précis (un CNAME `_xxxx.food...`) ;
  Terraform le crée dans la zone du compte network, ACM le voit et valide.
  Le certificat se renouvelle tout seul tant que cet enregistrement existe.
- **API Gateway custom domain** : associe ce nom (et son certificat) à l'API.
- **Enregistrements alias A et AAAA** : un alias Route 53 pointe vers une
  ressource AWS (ici l'endpoint régional de l'API) au lieu d'une IP fixe.
  Gratuits à interroger, et ils suivent les IP d'AWS si elles changent.
- **Deux comptes dans un même Terraform** : la zone DNS est dans le compte
  network (étape 7), tout le reste dans staging. Terraform a deux
  « providers » AWS, un par compte. En local, chacun utilise mon profil
  Identity Center ; en CI, le provider network assumera le rôle
  `ci/mcp-dns-staging-apply`, qui ne peut modifier que les noms finissant par
  `.staging.lab.michaelteplov.com`.
- **L'URL `execute-api` par défaut est désactivée** : un seul point d'entrée,
  celui qui figure dans le `aud` des jetons.

Pourquoi le domaine custom dès le départ : l'URL du serveur est l'identifiant
du resource server Cognito et le préfixe des scopes (spike 1). La changer plus
tard casserait toutes les connexions.

### DynamoDB : une table, une partition par utilisateur

- **Clé de partition `PK = USER#<sub>`** : toutes mes données sont au même
  endroit, et le `sub` vient du jeton vérifié. Le code ne peut pas lire la
  partition de quelqu'un d'autre sans un autre jeton.
- **Clé de tri `SK = ENTRY#<date locale>#<heure>#<id>`** : les entrées sont
  rangées par date, donc « le 9 novembre » ou « la semaine dernière » est une
  seule requête (`SK BETWEEN ENTRY#2026-11-03 AND ENTRY#2026-11-09#~`).
- **Pointeur `ENTRYREF#<id>`** : l'ID d'une entrée reste stable même si je
  corrige son heure (ce qui change sa clé de tri). Le pointeur dit où elle
  est.
- **À la demande** : payé à la requête, zéro quand rien ne se passe.
- **Point-in-time recovery** : restauration à la seconde près sur 35 jours.
- **Protection contre la suppression** + `prevent_destroy` : supprimer la
  table demande deux actions volontaires.
- **TTL** : les enregistrements d'idempotence ont une date d'expiration ;
  DynamoDB les supprime tout seul, gratuitement.

### Les transactions et l'idempotence

`log_food` écrit trois éléments **dans une seule transaction**
(`TransactWriteItems`, tout ou rien) :

1. l'enregistrement d'idempotence `IDEM#<clé>`, **seulement s'il n'existe pas
   déjà** (condition `attribute_not_exists`) ;
2. l'entrée ;
3. son pointeur.

Si claude.ai renvoie la même requête (coupure réseau, timeout), la condition
échoue, **toute** la transaction est annulée (rien n'est écrit en double), et
le serveur renvoie le résultat du premier appel. Si la même clé arrive avec un
contenu différent (une empreinte SHA-256 de la requête est stockée), c'est
refusé : c'est un bug du client, pas un renvoi.

Les corrections et suppressions n'ont pas besoin de clé : les appliquer deux
fois donne le même résultat (« idempotentes par nature »).

### Le fuseau horaire

Lambda tourne en UTC. Un « jour », pour moi, est un jour à Paris. Le code
convertit toujours avec un fuseau explicite (`Intl`) : un snack à 00h30 heure
de Paris (23h30 UTC) compte pour le nouveau jour. Une heure sans fuseau
(« 19:30 ») est lue à Paris, passage à l'heure d'été compris. Testé.

### Validation : ce que le serveur refuse

- Des valeurs hors plage (négatives, 50 000 kcal), via les schémas Zod, avant
  même que le code de l'outil tourne.
- Des kcal incohérentes avec les macros : 4 kcal/g pour protéines et glucides,
  9 pour les lipides, 7 pour l'alcool, à ±25 % (ou 15 kcal pour les petites
  valeurs). Ça attrape un chiffre mal placé.
- Une heure dans le futur ou de plus d'un an.

Le message d'erreur est renvoyé à Claude comme une erreur d'outil, pour qu'il
corrige et réessaie.

Les **sommes** sont faites en dixièmes entiers : 0,1 + 0,1 + … (dix fois) donne
exactement 1,0, ce que les nombres flottants ne garantissent pas.

### Les scopes par outil

Les outils de lecture exigent `food:read`, ceux d'écriture `food:write`
(`requireScopes` du SDK). Un jeton qui n'a que la lecture et essaie d'écrire
reçoit un **403 `insufficient_scope`** avec l'en-tête qui dit quel scope
manque. C'est ce qui protégera les données quand le dashboard (lecture seule)
existera.

### Les instructions serveur

Le serveur envoie à Claude un texte d'instructions : estimer chaque
ingrédient séparément, ne jamais additionner de tête, annoncer l'estimation
avant d'enregistrer, une clé d'idempotence par repas, ne jamais suggérer de
manger moins pour compenser. C'est ce qui détermine le plus la qualité des
données.

### Le rôle IAM de la Lambda

Il ne peut faire que `GetItem`, `Query`, `PutItem`, `UpdateItem`,
`DeleteItem`, `ConditionCheckItem` sur **cette** table, et écrire dans son
propre groupe de logs. Pas de `Scan`, pas d'autre table. Et il porte la
permissions boundary du landing zone, qui plafonne de toute façon.

### Les logs

JSON structuré, 14 jours de rétention. On logue les codes de statut, les
durées, le client, les échecs d'auth ; **jamais** les jetons, **jamais** ce que
j'ai mangé. Les données de santé restent dans la table.

## 3. Choix assumés

- **Zip et pas image conteneur pour l'instant.** Le code serveur parle
  `Request`/`Response` standard ; seul un petit adaptateur convertit les
  événements API Gateway. Passer à une image (pour Fargate) changera ce point
  d'entrée, pas le serveur. Les images ARM se construiront en CI.
- **Pas de VPC.** La Lambda parle à DynamoDB par les endpoints publics d'AWS,
  authentifiés par IAM. Un VPC ajouterait un NAT payant pour rien.

## 4. Questions d'entretien

**Comment évites-tu qu'un repas soit compté deux fois ?** Une clé
d'idempotence par création, écrite dans la même transaction que l'entrée avec
une condition « n'existe pas encore ». Un renvoi annule toute la transaction
et reçoit le résultat d'origine.

**Comment un utilisateur est-il isolé des autres ?** Le `sub` vient du jeton
vérifié et sert de clé de partition. Aucun outil ne prend d'ID utilisateur en
paramètre. Et la table n'est accessible qu'au rôle de cette Lambda.

**Pourquoi DynamoDB plutôt que Postgres ?** Les accès sont tous « mes données
d'un jour ou d'une période » : une requête par clé, parfait pour DynamoDB.
Coût quasi nul au repos, pas de démarrage à froid de 15 s comme Aurora
Serverless qui revient de zéro.

**Comment as-tu testé ?** Tests unitaires sur la logique pure (calories,
sommes, fuseau horaire), smoke test local de la couche MCP avec un faux
vérificateur de jeton (401, 403, validation), puis tests sur le vrai domaine
après déploiement.
