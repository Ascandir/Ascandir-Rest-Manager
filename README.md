# Ascandir - Rest Manager

Überarbeitete lange Rast für **Foundry VTT v14 (ausgelegt auf 14.368)** und **D&D 5e 6.0 (ausgelegt auf 6.0.6)**.

## Installation

In Foundry unter *Module installieren* diese Manifest-URL einfügen:

```
https://github.com/Ascandir/Ascandir-Rest-Manager/releases/latest/download/module.json
```

## So läuft es ab

1. **SL:** In der Akteure-Seitenleiste auf **„Lange Rast anfragen“** klicken und die Teilnehmer auswählen. Begleiter und Reittiere der Spieler (z. B. Wolf oder Pferd) stehen ebenfalls zur Auswahl.
2. Bei allen öffnet sich das **Lagerfenster** mit der Gruppe.
3. **Spieler** ziehen ihre Rationen/Lagervorräte (aus „Deine Vorräte“ oben im Fenster oder direkt vom Charakterbogen) auf die Karte eines Gruppenmitglieds – auf die eigene oder auf die eines anderen, um auszuhelfen.
   - **Shift** beim Ablegen = Anzahl wählen.
   - Mit dem **–**-Knopf nimmt man ein Stück wieder heraus.
4. Versorgte Charaktere werden **grün mit Haken** angezeigt, unversorgte **rot**.
5. **SL:** Bei unversorgten Charakteren kann die Strafe per Knopf **erlassen** werden. Dann **„Rast starten“** – die Vorräte werden abgezogen, alle rasten, Unversorgte bekommen die Strafe.

Spieler, die das Fenster geschlossen haben, öffnen es über **„Lager öffnen“** in der Akteure-Seitenleiste wieder.

## Einstellungen (nur SL)

*Spieleinstellungen → Moduleinstellungen → Ascandir - Rest Manager*

- **Vorräte festlegen:** Welche Gegenstände zählen (Name oder Identifier), wie viele Punkte ein Stück wert ist und wie viele Punkte eine Kreatur **je nach Größe** braucht (Winzig, Klein, Mittelgroß, Groß, Riesig, Gigantisch). Die Größe kommt aus dem Bogen. Gegenstände lassen sich hineinziehen.
- **Strafe festlegen:** Keine Rast · keine Trefferpunkte · keine Trefferwürfel · keine Zauberplätze · zusätzliche Erschöpfung · Zustand „Unterernährt“ · eigene Chatnachricht.

## Makro

```js
game.modules.get("ascandir-rest-manager").api.startRequest();
```

## Lizenzen

Die Schrift *Alegreya* steht unter der SIL Open Font License (siehe `fonts/OFL-LICENSE.txt`).
