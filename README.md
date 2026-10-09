# Ascandir - Rest Manager

Überarbeitete lange Rast für **Foundry VTT v14** und **D&D 5e 5.3**.

## Installation

In Foundry unter *Module installieren* diese Manifest-URL einfügen:

```
https://github.com/Ascandir/Ascandir-Rest-Manager/releases/latest/download/module.json
```

## So läuft es ab

1. **SL:** In der Akteure-Seitenleiste auf **„Lange Rast anfragen“** klicken und die Teilnehmer auswählen.
2. Bei allen öffnet sich das **Lagerfenster** mit der Gruppe.
3. **Spieler** ziehen ihre Rationen/Lagervorräte (aus „Deine Vorräte“ oben im Fenster oder direkt vom Charakterbogen) auf die Karte eines Gruppenmitglieds – auf die eigene oder auf die eines anderen, um auszuhelfen.
   - **Shift** beim Ablegen = Anzahl wählen.
   - Mit dem **–**-Knopf nimmt man ein Stück wieder heraus.
4. Versorgte Charaktere werden **grün mit Haken** angezeigt, unversorgte **rot**.
5. **SL:** Bei unversorgten Charakteren kann die Strafe per Knopf **erlassen** werden. Dann **„Lange Rast durchführen“** – die Vorräte werden abgezogen, alle rasten, Unversorgte bekommen die Strafe.

Spieler, die das Fenster geschlossen haben, öffnen es über **„Lager öffnen“** in der Akteure-Seitenleiste wieder.

## Einstellungen (nur SL)

*Spieleinstellungen → Moduleinstellungen → Ascandir - Rest Manager*

- **Vorräte festlegen:** Welche Gegenstände zählen (Name oder Identifier), wie viele Punkte ein Stück wert ist, wie viele Punkte jeder Charakter braucht. Gegenstände lassen sich hineinziehen.
- **Strafe festlegen:** Keine Rast · keine Trefferpunkte · keine Trefferwürfel · keine Zauberplätze · zusätzliche Erschöpfung · eigene Chatnachricht.

## Makro

```js
game.modules.get("ascandir-rest-manager").api.startRequest();
```
