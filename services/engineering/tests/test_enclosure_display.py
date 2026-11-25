"""A casing built around a screen and several boards, and housings around boards with rounded corners."""
import unittest

try:
    import cadquery as cq
except ImportError:   # the geometry kernel is in the engineering image
    cq = None

from vx_eng.enclosure import EnclosureSpec, build, stack_bodies


def spec(**extra):
    return EnclosureSpec.from_json({"process": "sls", "material": "PA12", "wall_mm": 2.5, "edge_gap_mm": 3, "top_clearance_mm": 4,
                                    "standoff_height_mm": 6, "fastening": "heat_set_insert", "openings": [], "draft_deg": 1, **extra})


@unittest.skipIf(cq is None, "cadquery is not installed")
class RoundedBoardTest(unittest.TestCase):
    def test_cavity_is_cut_around_a_board_with_rounded_corners(self):
        # Arcs in the outline once made every cut silently do nothing (a solid block with the board buried in it).
        board = cq.Workplane().box(120, 80, 1.6, centered=(False, False, False)).edges("|Z").fillet(3).val()
        facts = {"thickness_mm": 1.6, "holes": [{"ref": "H1", "x": 5, "y": 5, "size": "M3"}]}
        for draft in (0, 1):
            b = build(spec(draft_deg=draft), board, {}, facts)
            for part in ("base", "lid"):
                self.assertTrue(b[part].isValid(), part)
                self.assertLess(b[part].intersect(board).Volume(), 1.0, f"draft {draft}: the board is clear of the {part}")


@unittest.skipIf(cq is None, "cadquery is not installed")
class DisplayCasingTest(unittest.TestCase):
    def setUp(self):
        self.board = cq.Solid.makeBox(60, 40, 1.6)
        self.facts = {"thickness_mm": 1.6, "holes": [{"ref": "H1", "x": 5, "y": 5, "size": "M3"}]}
        self.comps = {"U1": cq.Solid.makeBox(10, 10, 5, cq.Vector(20, 15, 1.6))}
        self.spec = spec(display={"width_mm": 100, "height_mm": 70, "thickness_mm": 4, "opening_w_mm": 90, "opening_h_mm": 60,
                                  "center_x_mm": 45, "center_y_mm": 20},
                         extra_boards=[{"name": "sensor", "width_mm": 20, "height_mm": 20, "part_height_mm": 8, "center_x_mm": 80, "center_y_mm": 20}])

    def test_casing_covers_the_screen_and_boards_with_a_bezel_opening(self):
        comps = {**self.comps, **stack_bodies(self.spec, self.board, self.comps, self.facts)}
        disp = comps["DISPLAY"].BoundingBox()
        # The screen sits in front of the tallest part (the 8 mm sensor board) plus the top clearance.
        self.assertAlmostEqual(disp.zmin, 1.6 + 8 + 4, places=3)
        b = build(self.spec, self.board, comps, self.facts)
        outer = b["outer_bb"]
        self.assertLessEqual(outer.xmin, disp.xmin - 3)
        self.assertGreaterEqual(outer.xmax, disp.xmax + 3)
        for name, body in comps.items():
            for part in ("base", "lid"):
                self.assertLess(b[part].intersect(body).Volume(), 0.5, f"{name} is clear of the {part}")
        # The bezel opening: nothing above the middle of the screen; the lid still covers the screen's edge.
        lid = b["lid"]
        top = b["levels"]["top_outer"]
        probe = lambda x, y: cq.Solid.makeBox(1, 1, 1, cq.Vector(x, y, top - 1.5))  # noqa: E731
        self.assertLess(lid.intersect(probe(45, 20)).Volume(), 1e-6)
        self.assertGreater(lid.intersect(probe(45, 20 + 35 - 1.5)).Volume(), 0.5)
        self.assertTrue(any(o.get("kind") == "bezel" for o in b["openings"]))


if __name__ == "__main__":
    unittest.main()
