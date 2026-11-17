# VX Design Note VXN-001: Oscillator Layout

## 1. Scope

This note covers board layout around the timecode reference oscillator. It is original VX Design text, published under CC BY 4.0, written for tests and as a starting checklist.

## 2. Guard ring

Surround the crystal and its two load capacitors with a grounded guard ring on the top layer.

Keep switching regulator traces and their inductors at least 2 mm from the guard ring.

Stitch the guard ring to the ground plane with vias every 3 mm.

## 3. Battery charging temperature

Charge a lithium-ion cell only between 0 °C and 45 °C. Stop charging when the thermistor reads outside that window and report it to the user.
