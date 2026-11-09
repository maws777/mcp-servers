# Phase 2 expliquée : meal prep, casseroles, favoris, suivi

Code : `apps/food/src/domain/batch.ts`, `store/batches.ts`, `store/catalog.ts`,
`tools/mealprep.ts`, `tools/tracking.ts`. Design : `docs/design/food-v1.md`.

## 1. Les outils ajoutés (13, total 18)

| Groupe | Outils | En une phrase |
|---|---|---|
| Meal prep | `create_batch`, `list_batches`, `eat_from_batch`, `update_batch`, `close_batch` | Un plat cuisiné, dont on prend des parts sur plusieurs repas |
| Casseroles | `save_pot`, `list_pots` | Le poids à vide de chaque casserole, pour obtenir le poids cuit |
| Favoris | `save_food`, `find_my_food`, `delete_food` | Des valeurs enregistrées, réutilisées au lieu d'être réestimées |
| Suivi | `set_targets`, `get_trends`, `log_weight` | Objectifs du jour, tendances sur 7 à 90 jours, poids |

## 2. Le meal prep, mécanisme par mécanisme

### Un plat = ses ingrédients, sommés par le serveur

`create_batch` reçoit les ingrédients avec leurs quantités (crus), estimés un
par un par Claude. Le serveur vérifie chacun (plages, cohérence calories /
macros), les additionne, et stocke le total du plat. Les plages sont plus
larges que pour un repas (un ingrédient de batch peut monter à 10 000 kcal :
2 kg de riz cru en font ~7 200), avec un plafond de 30 000 kcal par plat.

### Le poids : cru, cuit, et la tare

- **Poids cru** (`raw_grams`) : la somme des grammes des ingrédients, gardée à
  titre d'information. Seulement si tous les ingrédients ont un poids.
- **Poids cuit** (`total_grams`) : ce que pèse le plat une fois cuit (la
  cuisson fait perdre ou gagner de l'eau). C'est lui qui permet de manger
  « 350 g ».
- **Tare** : chaque casserole est pesée une fois à vide, sans couvercle
  (`save_pot`). « 2,1 kg dans la casserole 3 » devient
  `gross_grams: 2100, pot: "3"`, et le serveur calcule 2 100 − 700 = 1 400 g.

### Les fractions en entiers

Une part est stockée en **dix-millièmes entiers** du plat (le plat entier =
10 000, un tiers = 3 333). Pourquoi pas un nombre à virgule :

- en binaire, 1/3 n'est pas représentable exactement, et 1 − 1/3 − 1/3 − 1/3
  ne fait pas tout à fait 0 ;
- avec des entiers, « le reste » prend exactement ce qui reste : trois tiers
  vident la marmite à zéro ;
- à moins de 0,01 du reste, une part compte comme « le reste » (pour éviter un
  fond de 0,0001 qui traînerait dans le frigo).

`eat_from_batch` accepte une fraction, des grammes (divisés par le poids cuit),
des portions (divisées par le nombre de portions annoncé) ou `rest: true`. Le
serveur convertit, vérifie qu'il en reste assez, et calcule les macros de la
part : total du plat × part, arrondi au dixième (en entiers aussi).

### Une transaction pour une part

Manger une part écrit, en **une seule transaction DynamoDB** :

1. l'enregistrement d'idempotence (s'il est nouveau) ;
2. la mise à jour du batch : nouveau reste, statut « finished » si c'est
   vide ;
3. une ligne de journal du batch (`BATCHLOG`) : qui a mangé quoi, quand ;
4. pour moi seulement : l'entrée dans mon journal et son pointeur.

Tout ou rien. Jamais une entrée sans la baisse du reste, jamais une baisse
sans l'entrée. Pour « quelqu'un d'autre », seuls 1 à 3 sont écrits : la part
sort de la marmite, mon compteur ne bouge pas.

### Le verrouillage optimiste

Problème classique : deux requêtes en même temps lisent « il reste un tiers »
et prennent chacune « le reste ». Sans protection, on mangerait deux tiers d'un
tiers.

Solution : chaque modification du batch est **conditionnée à la valeur lue
juste avant** (« écris le nouveau reste seulement si le reste vaut encore
3 333 »). La deuxième requête voit sa condition échouer, toute sa transaction
est annulée, elle relit le batch et refait le calcul (une fois, toute seule).
C'est le « verrouillage optimiste » : on ne bloque personne, on vérifie au
moment d'écrire. L'alternative (verrouiller avant de lire) serait plus lente et
inutile avec un seul utilisateur.

### Une part reste liée à son plat

L'entrée d'une part garde `batch_id` et sa part (`batch_units`), pas seulement
des chiffres. Conséquences :

- **Corriger la recette** (`update_batch` avec de nouveaux ingrédients)
  recalcule le plat **et** toutes les parts déjà mangées, dans la même
  transaction. « C'était du bœuf à 20 % » corrige aussi ce que j'ai mangé
  hier. Les parts gardent leur proportion du plat, seul le contenu change.
- **On ne peut pas modifier le contenu d'une part** directement : il vient du
  plat. `update_entry` peut seulement changer son heure ou son repas.
- **Supprimer une part la remet dans la marmite** (et rouvre le batch si
  c'était la dernière part), sauf si le plat a été jeté.

## 3. Favoris, objectifs, tendances, poids

- **Favoris** : un nom, une portion (« 30 g + eau ») et ses valeurs. Recherche
  par mots, sans tenir compte des accents ni des majuscules (« bœuf haché »
  trouve « Boeuf Hache »). Enregistrer le même nom remplace l'ancien.
- **Objectifs** : n'importe quel sous-ensemble (kcal, protéines...) ; les
  autres restent. `daily_summary` affiche alors ce qu'il reste à atteindre. Le
  fuseau horaire est vérifié (un nom inconnu est refusé).
- **Tendances** : totaux par jour sur 7 à 90 jours, moyenne sur les jours
  loggés (aujourd'hui exclu, puisqu'il n'est pas fini), jours dans l'objectif
  (kcal à ±10 %, protéines atteintes), série de jours loggés, évolution du
  poids. Tout est calculé à la lecture, rien n'est stocké en double.
- **Poids** : un par jour ; une deuxième pesée le même jour remplace la
  première.

## 4. Comment c'est testé

- **32 tests unitaires** sur la logique pure : fractions, grammes, portions,
  reste, trois tiers qui vident exactement, refus d'en prendre trop, tare,
  arrondis, recherche sans accents.
- **Un scénario complet contre la vraie table staging**, lancé en local avec
  un faux vérificateur de jeton et un faux utilisateur (`smoke-test`), donc une
  partition séparée de la mienne, effacée ensuite. Il a vérifié les
  transactions, les conditions, l'idempotence (même clé = même résultat, même
  clé et autre contenu = refus), le recalcul des parts, la remise dans la
  marmite et tous les messages d'erreur.

## 5. Questions d'entretien

**Comment évites-tu que deux requêtes prennent le même dernier morceau ?**
Verrouillage optimiste : l'écriture est conditionnée à la valeur lue. La
perdante échoue, relit, recalcule.

**Pourquoi des entiers pour les fractions ?** Les flottants binaires ne
représentent pas 1/3 exactement ; des dix-millièmes entiers rendent « le
reste » exact et les sommes reproductibles.

**Que se passe-t-il si je corrige une recette après avoir mangé ?** Les parts
sont liées au plat par leur proportion : le serveur recalcule le plat et les
parts dans une seule transaction.

**Pourquoi le serveur fait-il les calculs plutôt que Claude ?** Un modèle de
langage peut se tromper sur 2 118 × 0,3333. Le modèle estime ce qu'il sait
estimer (le contenu d'un ingrédient), le code fait ce que le code fait sans
erreur (l'arithmétique).
