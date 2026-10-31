// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract SpendVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4053559471634658367092799679406441981895408920157620575060672746808513128957;
    uint256 constant deltax2 = 6731179225796727881086287252692296496010674025333880489442014720466881748725;
    uint256 constant deltay1 = 12303023058627001154560439368506948370837251423564545617600331142280020561131;
    uint256 constant deltay2 = 9620239103042751190413025107019320972264314895608543998452177179905999783821;

    
    uint256 constant IC0x = 12348598536939412742594620781460733762584889024552190545107712357859040614200;
    uint256 constant IC0y = 13184118065500334576396352920422919164248840280343172207525841221068230441465;
    
    uint256 constant IC1x = 14620015593155257015108322601049504001442570404348366874952201703292941513638;
    uint256 constant IC1y = 10517836454061759717632207414987238732068490180661843293185344733177173890866;
    
    uint256 constant IC2x = 2295885851550811004841172429238932274994652481332929612179607634858708070665;
    uint256 constant IC2y = 9334473037948907644969238592649108939065852849422521683885284395742534858616;
    
    uint256 constant IC3x = 18209749094987450540956411313144473649306242123737382025336900531475565854960;
    uint256 constant IC3y = 10885829394421950829289109548929731757452886700235571029652671803692522550570;
    
    uint256 constant IC4x = 6966444437231807850580769686422236717445154035508201620908936467936305434289;
    uint256 constant IC4y = 883948939959212327723389345347686782051133831643481823349246332968320040265;
    
    uint256 constant IC5x = 20150370109831226896265173475630026370937825325336075942404341939017662439723;
    uint256 constant IC5y = 21031752160674546411750775694569594843982436024353429064786642667532285648627;
    
    uint256 constant IC6x = 8788902536435664384824414719733417871086159323928076149485301061147804792569;
    uint256 constant IC6y = 15409059930224843587425697788427498367377246170211234794740517780774861407601;
    
    uint256 constant IC7x = 10425567941359777245943429356212961554195399558871373279642522018613648938498;
    uint256 constant IC7y = 1609657767587459941408092468079403360320572477390789399909410471853604076307;
    
    uint256 constant IC8x = 5785784195812671695044357684799452374307305744304355685227876501927402059652;
    uint256 constant IC8y = 21747800254163464342132055513441730393190664092904603129558310975231765470143;
    
    uint256 constant IC9x = 11555437279270037024952879713211563899335538045453387629976605570091163135243;
    uint256 constant IC9y = 4630178919029426726107892209214025072613952910322550075966822791196756944005;
    
    uint256 constant IC10x = 15081619844061810659199635292736071926817757560449084310751695032081886321132;
    uint256 constant IC10y = 9376645831884855524996314953908054254287834944784078414782005098212483563524;
    
    uint256 constant IC11x = 7630542108332281700023494658414594855041402084679561494290729976634077068023;
    uint256 constant IC11y = 12821097009384034618955575350809413936868888239281122941031941948610796013463;
    
    uint256 constant IC12x = 4256393587171196189135684400370631127704197357534908700065704713607746356316;
    uint256 constant IC12y = 21142444815304515409560451170764360160490699607001194877908046289298688501708;
    
    uint256 constant IC13x = 16636649290099942094176557025749961688799272376286911980281957602725962286917;
    uint256 constant IC13y = 1999058786631242875645766494693849080948388244758994583144035235820129090300;
    
    uint256 constant IC14x = 19045021960889628976488967325153832408911790290684818142197946001486565011373;
    uint256 constant IC14y = 13721556186273979819483463156790297168154166800674858945145898672091863437751;
    
    uint256 constant IC15x = 8259432503445420387218756745561008712737919117695940801933664104260907232202;
    uint256 constant IC15y = 21498038226932368233301548140541081719132195695821900327967232882056996233311;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
