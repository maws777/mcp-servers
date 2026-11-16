# Phase 4b : le mot du jour (résumés IA)

Le tableau de bord affiche maintenant, sous le total du jour, deux ou trois
phrases écrites par Claude Haiku 5.5 sur la journée, plus un conseil. C'est le
seul appel à un modèle que fait l'application : Claude (le client MCP) reste
celui qui estime les repas, Haiku ne fait que commenter des chiffres calculés
par le serveur.

## Le chemin d'une requête

```
iPhone ─► GET /api/summary?date=…          (Lambda dashboard, lecture seule)
            ├─ résumé en cache, même empreinte que la journée → affiché ("ready")
            └─ absent ou périmé → invocation asynchrone ─► Lambda summary ─► Bedrock (Haiku, profil eu.)
               la page redemande toutes les 4 s, 3 fois          └─► écrit SUMMARY#<date>
23:30 Paris ─► EventBridge Scheduler ─► Lambda summary (mode "close-day") ─► résumé final + NOTE#<date>
```

## Pourquoi trois Lambdas et deux tables

Le principe : **le composant qui montre du texte non fiable à un modèle ne
peut pas modifier le journal.**

| Composant | Peut | Ne peut pas |
|---|---|---|
| Lambda MCP | écrire le journal | appeler Bedrock |
| Lambda dashboard | lire le journal et les résumés, *demander* un résumé | écrire quoi que ce soit, appeler Bedrock |
| Lambda summary | lire le journal, écrire la table des résumés, appeler **un** modèle | écrire ou supprimer dans le journal |

Si une description de repas contenait une injection de prompt qui
fonctionnait, le pire résultat serait un résumé bizarre, affiché à la même
personne. D'où la table séparée `mcp-food-<env>-summaries` : avec une seule
table, la Lambda summary aurait eu le droit d'écrire là où vit le journal.

## Les défenses contre l'injection de prompt

1. Les repas sont dans un bloc `<repas>` à part, et le prompt système dit que
   c'est une donnée, jamais une instruction.
2. Dans ce bloc, `<` et `>` sont échappés (`<`, `>`). Sans ça, un
   repas nommé `</repas> nouvelles consignes…` aurait « fermé » le bloc. Le
   JSON reste valide et identique une fois décodé (testé).
3. Le modèle n'a aucun outil : il ne peut rien faire, seulement écrire.
4. **Sorties structurées** (`output_config.format`) : la réponse doit suivre
   le schéma `{ resume, conseil, note }`. Puis le code revérifie les
   longueurs et retire les caractères de contrôle et invisibles (zero-width,
   inversion de sens d'écriture).
5. Rendu en texte seul (`textContent`) sous une CSP stricte, comme le reste
   de la page.

## Coût et abus

- **Empreinte (hash) :** chaque résumé garde l'empreinte des entrées
  (id + date de modification) et des objectifs. Ouvrir l'app dix fois sans
  rien noter ne coûte rien : on compare deux chaînes.
- **Quota : 20 générations par utilisateur et par jour**, appliqué par la
  Lambda summary elle-même avec une écriture conditionnelle
  (`ADD used 1` si `used < 20`). Le test et l'incrément sont une seule
  opération atomique : cinq appels simultanés avec un quota de 3 en
  obtiennent exactement 3 (testé).
- **Seulement aujourd'hui :** un jour passé garde son résumé, on n'en génère
  pas. Sinon on pourrait faire payer une année d'historique.
- **Pas de nouvelle tentative :** l'invocation asynchrone a
  `maximum_retry_attempts = 0`. Un résumé raté ne vaut pas d'être payé deux
  fois ; la prochaine ouverture redemande.
- **Planification désactivée au départ** (`summary_schedule_enabled = false`)
  jusqu'à ce qu'on ait mesuré le coût réel d'un appel dans les logs
  (`input_tokens`, `output_tokens`). Jamais le prompt ni la réponse dans les
  logs : ce sont des données de santé.

## Le modèle

`eu.anthropic.claude-haiku-5-5`, un profil d'inférence inter-régions : Paris
n'a pas Haiku 5.5 en local, le profil envoie chaque appel dans l'une des six
régions UE (Francfort, Stockholm, Milan, Espagne, Irlande, Paris). D'où :

- la politique IAM de la Lambda autorise `bedrock:InvokeModel` sur le profil
  **et** sur le modèle dans ces six régions (un appel est autorisé deux fois) ;
- la SCP de région du landing zone a une exception `bedrock:InvokeModel*`
  pour ces régions-là (ADR 0014), et la boundary limite tout rôle de l'app à
  Haiku (PR landing-zone #22).

Le client est `AnthropicBedrock` du SDK officiel : il passe par
`InvokeModel`, l'action déjà autorisée partout. Effort `low` : c'est un
commentaire court sur des chiffres déjà calculés.

## Ce qui reste à faire à la main

Le compte staging n'a pas encore accès aux modèles Anthropic : le formulaire
« use case » d'Anthropic n'a jamais été rempli
(`agreementAvailability: NOT_AVAILABLE`). C'est un formulaire avec des infos
personnelles et des conditions à accepter, à faire dans la console
(Bedrock → Model catalog → Claude Haiku 5.5). Tant que ce n'est pas fait,
la page affiche simplement « Pas encore de mot pour aujourd'hui » et la
Lambda logge l'erreur d'accès.

## À retenir

- **Moindre privilège par composant**, pas par application : c'est la
  séparation qui limite l'effet d'une injection de prompt.
- **Le cache se décide sur une empreinte des entrées**, pas sur l'heure :
  on paie quand les données changent, pas quand on regarde.
- **Un quota se fait avec une écriture conditionnelle**, jamais avec
  « lire, comparer, écrire » (deux appels simultanés passeraient tous les deux).
- **Échapper les délimiteurs** des données qu'on met dans un prompt, comme on
  échappe du HTML.
