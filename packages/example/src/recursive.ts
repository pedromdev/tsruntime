import { Reflective } from "tsruntime";

@Reflective
class Recursive {
  prop!: Recursive;
  model!: StatsModel;
}

interface StatsModel {
  a: StatsModel
}
