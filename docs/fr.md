# LIFX

Pilotez vos ampoules, rubans et matrices **LIFX** depuis Gladys, **en réseau
local**, avec le protocole LAN officiel de LIFX : ni cloud, ni compte, ni clé.

> Développée sans le matériel : vos retours sont les bienvenus
> (« Developed without the hardware: feedback welcome »). L'intégration a été
> écrite d'après le protocole public de LIFX et testée contre des lampes
> simulées. Si quelque chose ne se comporte pas comme décrit, ouvrez un ticket :
> https://github.com/guim31/gladys-lifx/issues

Cette intégration n'est pas affiliée à LIFX.

## Présentation

- Chaque lampe LIFX devient une lampe Gladys : marche/arrêt, luminosité,
  couleur, température de blanc (en kelvins, dans la plage de votre modèle).
- Les ampoules **Nightvision** ont leur niveau d'**infrarouge**.
- Les **rubans** (Z, Beam, Neon, String, Permanent Outdoor…) et les
  **matrices** (Tile, Candle, Ceiling, Spot, Path, Tube…) se pilotent en entier
  (marche/arrêt, luminosité, une couleur pour toute la lampe), avec la liste de
  leurs effets intégrés.
- Deux actions de scène : **Faire clignoter une lampe LIFX** (une alerte en
  couleur qui s'arrête d'elle-même) et **Lancer un effet LIFX** (Défilement,
  Morphose, Flamme).
- La connexion de chaque lampe est affichée et gardée dans l'historique.

## Prérequis

- Gladys 5.1 ou plus récent.
- Des lampes LIFX configurées dans l'application LIFX et connectées au même
  réseau que Gladys. L'application LIFX n'est plus nécessaire ensuite.
- Les lampes répondent sur le port UDP 56700. Gladys les trouve par une
  diffusion sur le réseau local : si Gladys et les lampes sont sur des réseaux
  différents (VLAN, Wi-Fi invités), saisissez leurs adresses IP dans la
  configuration.

## Configuration

1. Installez l'intégration (Intégrations → Installer depuis GitHub, ou depuis
   le store).
2. Ouvrez l'onglet **Configuration**. Tous les champs sont facultatifs :
   - **Adresses IP des lampes LIFX** : seulement pour les lampes que la
     découverte automatique ne trouve pas, séparées par des virgules.
     Donnez-leur une adresse fixe dans votre box.
   - **Intervalle d'actualisation** : fréquence de lecture de chaque lampe
     (10, 15, 30 ou 60 secondes, 15 par défaut), pour suivre les changements
     faits depuis l'application LIFX, un assistant vocal ou un interrupteur
     mural.
   - **Transition** : un fondu pour les changements faits depuis Gladys (aucun
     par défaut, jusqu'à 5 secondes).
   - **Langue des noms des fonctionnalités** : la langue des noms donnés aux
     fonctionnalités des nouvelles lampes (français par défaut).
3. Ouvrez l'onglet **Découverte** et ajoutez vos lampes. Leurs noms sont ceux
   donnés dans l'application LIFX ; vous pouvez les renommer dans Gladys.

Le bouton **Rechercher les lampes LIFX** de l'onglet Configuration recherche à
nouveau les lampes et liste celles trouvées, avec leur adresse et leur modèle.

## Appareils et fonctionnalités

Chaque lampe est un appareil Gladys, identifié par son numéro de série : elle
garde son historique, ses scènes et ses tableaux de bord quand son adresse IP
change.

| Fonctionnalité             | Lampes                      | Ce qu'elle fait                                                    |
| -------------------------- | --------------------------- | ------------------------------------------------------------------ |
| **Éclairage**              | toutes                      | marche/arrêt                                                       |
| **Luminosité**             | toutes                      | 0 à 100 % ; 0 éteint la lampe                                      |
| **Couleur**                | lampes couleur              | la couleur ; ne change jamais la luminosité                        |
| **Température de couleur** | lampes avec plage de blancs | le blanc en kelvins, dans la plage du modèle et du firmware        |
| **Infrarouge**             | Nightvision                 | 0 à 100 % de la puissance infrarouge                               |
| **Effet LIFX**             | rubans et matrices          | **Aucun**, les effets de la lampe, **Autre effet** (lecture seule) |
| **Connexion**              | toutes                      | 1 quand la lampe répond, 0 sinon (lecture seule)                   |

Une couleur, un blanc ou une luminosité allument aussi la lampe. Une lampe
éteinte prend d'abord sa nouvelle couleur, puis s'allume en fondu : elle ne
montre jamais son ancienne couleur. Une couleur ou un blanc arrêtent l'effet en
cours, qui les masquerait.

La couleur est affichée quand la lampe montre une couleur, la température de
couleur quand elle montre un blanc. Une lampe qui ne répond plus (coupée à
l'interrupteur, coupure de courant) est affichée éteinte, avec **Connexion** à 0
et le badge « injoignable ».

Les effets de la liste **Effet LIFX** : le **Défilement** fait glisser les
couleurs d'un ruban ; la **Morphose** mélange des couleurs et la **Flamme**
vacille sur une matrice. Depuis la liste, ils démarrent avec leurs réglages par
défaut ; l'action de scène laisse choisir la vitesse, le sens et les couleurs.
Un effet lancé depuis l'application LIFX que l'intégration ne lance pas
elle-même (Ciel, Balayage de couleurs…) s'affiche **Autre effet**.

## Actions de scène

### Faire clignoter une lampe LIFX

La lampe clignote ou pulse dans une couleur, un certain nombre de fois, puis
revient à ce qu'elle affichait. Une lampe éteinte s'allume pour le clignotement
et s'éteint ensuite, avec sa couleur. Fait pour les alertes : une porte restée
ouverte, la machine à laver terminée, quelqu'un à la porte.

- **Lampe LIFX** : la lampe.
- **Couleur** : rouge, orange, jaune, vert, cyan, bleu, violet, rose ou blanc
  (les ampoules blanches clignotent en blanc).
- **Effet** : **Clignoter** (allumé, éteint) ou **Respirer** (en douceur).
- **Durée d'un cycle** : de 0,25 à 5 secondes.
- **Nombre de cycles (1-50)** : 3 par défaut.

Sortie : **Durée du clignotement (s)**, pour attendre sa fin dans la scène.

### Lancer un effet LIFX

Allume la lampe et lance un effet intégré, qui tourne jusqu'à son arrêt (un
autre effet, une couleur, un blanc ou **Arrêter l'effet**).

- **Effet** : **Défilement (rubans)**, **Morphose (matrices)**, **Flamme
  (matrices)** ou **Arrêter l'effet**.
- **Vitesse** : lente, normale ou rapide.
- **Sens (Défilement)** : droite ou gauche.
- **Couleurs** : arc-en-ciel, feu, océan, forêt, pastel, ou **Couleurs déjà
  affichées (Défilement)**. Le défilement les répartit le long du ruban avant
  de les faire glisser ; la morphose les mélange ; la flamme garde ses
  couleurs.

Sortie : **Effet en cours (move, morph, flame, none)**.

## Pourquoi pas de widget

La boîte lumière de Gladys affiche et pilote déjà tout ce que fait une lampe
LIFX : marche/arrêt, luminosité, couleur, blanc, infrarouge et liste des effets.
Le clignotement et les effets avec leurs réglages sont des actions de scène, là
où ils servent (alertes, ambiances). Un widget LIFX ne ferait que répéter la
boîte lumière : il n'y en a donc pas.

## Exemples de scènes

- **Porte restée ouverte** : quand le capteur de la porte reste ouvert 5
  minutes → **Faire clignoter une lampe LIFX**, la lampe du salon, orange,
  Clignoter, 1 seconde, 5 cycles.
- **Sonnette** : quand la sonnette retentit → **Faire clignoter une lampe
  LIFX**, la lampe du bureau, bleu, Respirer, 0,5 seconde, 6 cycles (une
  action par lampe à prévenir).
- **Soirée film** : à 21 h, quand la télé s'allume → **Lancer un effet LIFX**,
  le ruban de la télé, Défilement, lente, océan ; et **Arrêter l'effet** quand
  elle s'éteint.
- **Lampe coupée à l'interrupteur** : quand la **Connexion** d'une lampe passe
  à 0 pendant 10 minutes → envoyer le message « la lampe de l'entrée n'est plus
  alimentée ».

## Trafic réseau et limites du protocole

- Le protocole LIFX ne pousse rien : chaque lampe ajoutée à Gladys est lue à
  l'intervalle d'actualisation (un ou deux petits paquets UDP, trois pour un
  ruban ou une matrice). LIFX demande aux clients de rester sous 20 messages
  par seconde et par lampe : l'intégration envoie un message à la fois par
  lampe, très en dessous.
- Gladys ne reçoit que les valeurs qui ont changé, plus les valeurs inchangées
  toutes les 6 heures pour que l'historique reste à jour.
- Les lampes sont recherchées à nouveau toutes les 15 minutes, pour suivre
  leurs changements d'adresse et trouver les nouvelles.
- L'intégration lit les lampes avec son propre minuteur : Gladys ne les
  interroge pas (les appareils sont publiés avec `should_poll: false`).

## Dépannage

- **Aucune lampe trouvée** : vérifiez que les lampes sont configurées dans
  l'application LIFX et sur le même réseau que Gladys. La découverte
  automatique passe par Gladys (Gladys 5.1 ou plus récent) ; sur un autre
  réseau, saisissez les adresses IP.
- **Une lampe est « injoignable »** : elle est coupée à l'interrupteur, ou son
  adresse a changé. L'intégration la retrouve d'elle-même à la recherche
  suivante ; donnez-lui une adresse fixe dans votre box pour l'éviter.
- **Les changements faits dans l'application LIFX arrivent en retard** : ils
  arrivent à la lecture suivante ; choisissez un intervalle d'actualisation plus
  court.
- **Un effet ne fait rien** : le Défilement n'existe que sur les rubans, la
  Morphose et la Flamme sur les matrices. Le Défilement avec **Couleurs déjà
  affichées (Défilement)** sur un ruban d'une seule couleur ne montre aucun
  mouvement : choisissez une palette.
- **Journaux** : l'intégration ne journalise que l'essentiel (démarrage, lampes
  trouvées, perdues et revenues, erreurs). Pour le détail, mettez
  `LOG_LEVEL=debug` sur le conteneur.

## Limites

- Développée sans le matériel : le comportement sur de vraies lampes LIFX reste
  à confirmer.
- Les rubans et les matrices se pilotent en entier : pas de couleur par zone.
- La couleur affichée pour un ruban ou une matrice est celle que la lampe
  annonce pour l'ensemble (sa première zone).
- Non gérés : le LIFX Switch (relais et boutons), le cycle de nettoyage HEV des
  ampoules LIFX Clean (l'ampoule elle-même fonctionne comme une lampe couleur),
  les effets Ciel et Balayage de couleurs (affichés **Autre effet**), le cloud
  LIFX et les scènes de l'application LIFX.
- Un produit plus récent que la liste de produits de l'intégration est géré
  comme une lampe couleur avec une plage de blancs de 1500 à 9000 K, jusqu'à
  une mise à jour.
