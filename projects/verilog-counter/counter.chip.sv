module counter(input wire clk, input wire rst,
               output wire q0, output wire q1, output wire q2, output wire q3);
  reg [3:0] count;
  always @(posedge clk or posedge rst)
    if (rst) count <= 4'b0; else count <= count + 1'b1;
  assign {q3, q2, q1, q0} = count;
endmodule
