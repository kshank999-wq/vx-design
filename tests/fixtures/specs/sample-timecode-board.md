# Sample Timecode Board Specification

> Fictional sample used for automated tests. It is not the VC Smart Slate specification.

## 1. Overview

The timecode board is a small add-on PCB that generates and reads SMPTE LTC timecode for a film slate. It connects to the slate motherboard over a single board-to-board connector.

## 2. Electrical requirements

- The board shall run from the motherboard 5 V rail with an input range of 4.5 V to 5.5 V.
- Total current draw shall not exceed 60 mA in normal operation.
- The board shall generate a 3.3 V rail for all logic using a low-dropout regulator.
- The timecode reference oscillator shall have a frequency stability of ±1 ppm or better from 0 °C to 40 °C.

### 2.1 Timecode interface

- The board shall output SMPTE 12M LTC at 23.976, 24, 25, 29.97 DF and 30 fps.
- LTC output level shall be adjustable from -10 dBu to +4 dBu into a 10 kΩ load.
- The board shall read external LTC and jam-sync its internal clock within 2 frames.

## 3. Mechanical requirements

| Parameter | Value |
|---|---|
| Board outline | 40 mm x 25 mm maximum |
| Layer count | 4 layers |
| Component height | 6 mm maximum on top side |

- The LTC connector shall be a Lemo 5-pin socket mounted on the board edge.

## 4. Verification

- Timecode drift shall be measured over 8 hours against a reference generator and must stay within 1 frame.
- All boards shall pass ERC and DRC with zero unwaived errors before ordering.
